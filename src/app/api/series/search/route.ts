import { supabaseAdminRead } from "@/lib/supabase/admin"
import { createClient } from "@/lib/supabase/server"
import { NextRequest, NextResponse } from "next/server"
import { checkRateLimit, sanitizeInput, handleApiError, ApiError, ErrorCodes, getClientIp } from "@/lib/api-utils"
import { checkSourceQueue, isQueueHealthy } from "@/lib/queues"
import { areWorkersOnline, redis, waitForRedis, REDIS_KEY_PREFIX } from "@/lib/redis"
import { detectSearchIntent } from "@/lib/search-intent"
import { recordSearchEvent } from "@/lib/analytics"
import { getBestCoversBatch, isValidCoverUrl } from "@/lib/cover-resolver"
import { FilterSchema } from "@/lib/schemas/filters"
import { FILTER_PARAMS, DEPRECATED_PARAMS } from "@/lib/constants/filters"
import { 
  buildSeriesQuery, 
  createSearchCursor,
  getSeriesIdsWithMultipleSources,
  stripSourcesFromResults
} from "@/lib/api/search-query"
import { prisma } from "@/lib/prisma"
import { PRODUCTION_QUERIES } from "@/lib/sql/production-queries"
import {
  getCachedSearchResult,
  setCachedSearchResult,
  checkPendingSearch,
  markSearchPending,
  clearPendingSearch,
  waitForPendingSearch,
  SEARCH_PRIORITY,
  consumeSearchQuota,
  checkPremiumSlidingWindow,
  incrementPremiumConcurrency,
deferSearchQuery,
} from "@/lib/search-cache"
import { 
  normalizeSearchQuery, 
  recordSearchIntent, 
  shouldEnqueueExternalSearch, 
  markQueryEnqueued,
  markQueryDeferred,
  EnqueueDecision
} from "@/lib/search-utils"
import { promoteSeriesTier } from "@/lib/catalog-tiers"

function getDiscoveryInfo(status: string, results: any[], skipReason?: string, isGuest?: boolean) {
  const resultsCount = results.length
  if (status === 'limit_reached') {
    return {
      discovery_status: 'limit_reached',
      discovery_state: 'LOCAL_ONLY',
      message: isGuest 
        ? "GUEST_LIMIT: You've reached the guest search limit. Please log in for more searches."
        : "LIMIT_REACHED: You've reached your daily external search quota. Showing local results only."
    }
  }
    if (skipReason === 'workers_offline') {
      return {
        discovery_status: 'maintenance',
        discovery_state: 'WORKERS_OFFLINE',
        message: "SYSTEM_BUSY: Our external discovery workers are currently offline. Showing local results only."
      }
    }
    if (skipReason === 'queue_overload') {
      return {
        discovery_status: 'maintenance',
        discovery_state: 'WORKERS_BUSY',
        message: "SYSTEM_BUSY: Discovery queue is currently overloaded. Showing local results only."
      }
    }
  if (skipReason === 'guest_gated') {
    return {
      discovery_status: 'login_required',
      discovery_state: 'GUEST_RESTRICTED',
      message: "LOGIN_REQUIRED: Deep discovery for repeat searches is reserved for logged-in users. Please sign in to search external sources."
    }
  }
  if (status === 'resolving') {
    return {
      discovery_status: resultsCount > 0 ? 'resolved' : 'queued',
      discovery_state: resultsCount > 0 ? 'FOUND' : 'QUEUED_FOR_DISCOVERY',
      message: resultsCount > 0 
        ? "FOUND: We found some matches in our database. We are also searching external sources for more results."
        : "QUEUED_FOR_DISCOVERY: We couldn't find any local matches. An external search has been queued. Please check back in a few seconds."
    }
  }
  if (resultsCount > 0) {
    return {
      discovery_status: 'resolved',
      discovery_state: 'FOUND',
      message: "FOUND: Search completed successfully."
    }
  }
  return {
    discovery_status: 'not_found',
    discovery_state: 'NOT_FOUND',
    message: "NOT_FOUND: No series found matching your search criteria."
  }
}

const VALID_SOURCES = new Set(['all', 'mangadex', 'multiple'])

function getParam(searchParams: URLSearchParams, canonicalKey: keyof typeof FILTER_PARAMS): string | null {
  const P = FILTER_PARAMS
  const canonicalName = P[canonicalKey]
  const canonicalValue = searchParams.get(canonicalName)
  if (canonicalValue !== null) return canonicalValue
  for (const [deprecated, canonical] of Object.entries(DEPRECATED_PARAMS)) {
    if (canonical === canonicalKey) {
      const deprecatedValue = searchParams.get(deprecated)
      if (deprecatedValue !== null) {
        console.warn(`[Search API] Deprecated param '${deprecated}' used. Use '${canonicalName}' instead.`)
        return deprecatedValue
      }
    }
  }
  return null
}

export async function GET(request: NextRequest) {
  const startTime = Date.now()
  const ip = getClientIp(request)
  const P = FILTER_PARAMS

  try {
    if (!await checkRateLimit(`search:${ip}`, 30, 60000)) {
      throw new ApiError("Too many requests", 429, ErrorCodes.RATE_LIMITED)
    }

    const searchParams = request.nextUrl.searchParams
    const intentParam = searchParams.get('intent')
      const rawFilters: any = {
        q: getParam(searchParams, 'query'),
        type: getParam(searchParams, 'types')?.split(',').filter(Boolean) || [],
        genres: searchParams.get(P.genres)?.split(',').filter(Boolean) || [],
        tags: getParam(searchParams, 'tags')?.split(',').filter(Boolean) || [],
        themes: getParam(searchParams, 'themes')?.split(',').filter(Boolean) || [],
      contentWarnings: {
        include: getParam(searchParams, 'includeWarnings')?.split(',').filter(Boolean) || [],
        exclude: getParam(searchParams, 'excludeWarnings')?.split(',').filter(Boolean) || [],
      },
      publicationStatus: getParam(searchParams, 'status')?.split(',').filter(Boolean) || [],
      contentRating: getParam(searchParams, 'rating')?.split(',').filter(Boolean) || [],
      readableOn: getParam(searchParams, 'source')?.split(',').filter(Boolean) || [],
      languages: {
        original: getParam(searchParams, 'origLang') || undefined,
        translated: getParam(searchParams, 'transLang')?.split(',').filter(Boolean) || [],
      },
      chapterCount: {
        min: getParam(searchParams, 'chapters') ? parseInt(getParam(searchParams, 'chapters')!) : undefined,
        max: undefined,
      },
      releasePeriod: {
        from: getParam(searchParams, 'dateFrom') || undefined,
        to: getParam(searchParams, 'dateTo') || undefined,
      },
      sortBy: getParam(searchParams, 'sort') || 'newest',
      sortOrder: 'desc',
      cursor: getParam(searchParams, 'cursor'),
      limit: parseInt(searchParams.get(P.limit) || '24'),
      mode: searchParams.get(P.mode) || 'all',
    }

    const validated = FilterSchema.safeParse(rawFilters)
    if (!validated.success) throw new ApiError("Invalid filters", 400, ErrorCodes.VALIDATION_ERROR)

    const filters = validated.data
    const queryStr = filters.q ? sanitizeInput(filters.q, 200) : null
    const normalizedKey = queryStr ? normalizeSearchQuery(queryStr) : null
    const escapedQuery = normalizedKey ? escapeILikePattern(normalizedKey) : null
    const requestedLimit = Math.min(Math.max(1, filters.limit), 100)
    
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    const dbUser = user ? await prisma.user.findUnique({
      where: { id: user.id },
      select: { subscription_tier: true, safe_browsing_mode: true }
    }) : null
    const isPremium = dbUser?.subscription_tier === 'premium'
    const safeBrowsingMode = dbUser?.safe_browsing_mode || 'sfw'

    if (normalizedKey) await recordSearchIntent(normalizedKey, user?.id)

    const rawSource = getParam(searchParams, 'source')
    const source = rawSource && VALID_SOURCES.has(rawSource.toLowerCase()) ? rawSource.toLowerCase() : null
    const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const cacheFilters = { ...filters, source }

    // Use optimized SQL for text search without cursor/source filter
    const useOptimizedSql = normalizedKey && !filters.cursor && !source && filters.mode === 'all'

    if (useOptimizedSql) {
      const cached = await getCachedSearchResult(normalizedKey!, cacheFilters)
      if (cached) {
        const uniqueResults = Array.from(new Map(cached.results.map((s: any) => [s.id, s])).values())
        recordSearchEvent({ normalized_query: normalizedKey!.toLowerCase().trim(), intent_type: 'TEXT', local_hit: true, external_attempted: false, results_count: uniqueResults.length, resolution_time_ms: Date.now() - startTime, status: 'cache_hit' })
        return NextResponse.json({ status: 'complete', results: uniqueResults, ...(cached.total !== undefined && { total: cached.total }), has_more: cached.has_more, next_cursor: cached.next_cursor, filters_applied: cacheFilters, cache_hit: true, cached_at: cached.cached_at, ...getDiscoveryInfo('complete', uniqueResults, undefined, !user) })
      }

      const pendingRequestId = await checkPendingSearch(normalizedKey!, cacheFilters)
      if (pendingRequestId) {
        const pendingResult = await waitForPendingSearch(normalizedKey!, cacheFilters, { maxPendingWaitMs: 3000 })
        if (pendingResult) {
          return NextResponse.json({ status: 'complete', results: pendingResult.results, ...(pendingResult.total !== undefined && { total: pendingResult.total }), has_more: pendingResult.has_more, next_cursor: pendingResult.next_cursor, filters_applied: cacheFilters, cache_hit: true, dedup_wait: true, ...getDiscoveryInfo('complete', pendingResult.results, undefined, !user) })
        }
      }
      await markSearchPending(normalizedKey!, cacheFilters, requestId)
    }

    let results: any[] = []
    let count: number | null = null
    let hasMore = false

    if (useOptimizedSql) {
      results = await prisma.$queryRawUnsafe<any[]>(
        PRODUCTION_QUERIES.SERIES_DISCOVERY,
        escapedQuery,
        filters.genres.length > 0 ? filters.genres : null,
        safeBrowsingMode,
        requestedLimit + 1
      )
      hasMore = results.length > requestedLimit
      if (hasMore) results = results.slice(0, requestedLimit)
    } else {
      let multipleSourceIds: Set<string> | null = null
      if (source === 'multiple') {
        multipleSourceIds = await getSeriesIdsWithMultipleSources(supabaseAdminRead)
        if (multipleSourceIds.size === 0) {
          if (normalizedKey && !filters.cursor) await clearPendingSearch(normalizedKey, cacheFilters)
          return NextResponse.json({ status: 'complete', results: [], total: 0, has_more: false, next_cursor: null, filters_applied: cacheFilters, ...getDiscoveryInfo('complete', [], undefined, !user) })
        }
      }
      const supabaseQuery = buildSeriesQuery(supabaseAdminRead, filters, source, multipleSourceIds)
      const { data, count: c, error } = await supabaseQuery
      if (error) {
        if (normalizedKey && !filters.cursor) await clearPendingSearch(normalizedKey, cacheFilters)
        throw error
      }
      results = data || []
      count = c
      if (source && source !== 'all' && source !== 'multiple') results = stripSourcesFromResults(results)
      hasMore = results.length > requestedLimit
      if (hasMore) results = results.slice(0, requestedLimit)
    }

    const seriesIds = results.map((r: any) => String(r.id)).filter(id => id && id !== 'undefined')
    
    // Track search_hit for top results and promote Tier C results
    await Promise.allSettled([
      ...seriesIds.slice(0, 5).map(id => promoteSeriesTier(id, 'user_search')),
      ...results.filter((r: any) => r.catalog_tier === 'C').map((r: any) => promoteSeriesTier(r.id, 'user_search'))
    ])

    const bestCovers = await getBestCoversBatch(seriesIds)

    const formattedResults = results.map((r: any) => ({
      ...r,
      best_cover_url: bestCovers.get(String(r.id)) || r.cover_url || r.best_cover_url
    }))

    let nextCursor = null
    if (hasMore && formattedResults.length > 0) {
      nextCursor = createSearchCursor(formattedResults[formattedResults.length - 1], filters.sortBy)
    }

    if (normalizedKey && !filters.cursor) {
      await clearPendingSearch(normalizedKey, cacheFilters)
    }

    let status = 'complete'
    let skipReason: string | undefined = undefined

    if (normalizedKey && !filters.cursor && formattedResults.length < 5) {
      try {
        const intent = detectSearchIntent(normalizedKey, results)
        const hasGoodMatch = formattedResults.some((r: any) => {
          const title = (r.title || '').toLowerCase()
          const q = normalizedKey.toLowerCase()
          return (title.includes(q) || q.includes(title)) && r.cover_url && r.description
        })

            if (intent !== 'NOISE' || !hasGoodMatch) {
              const redisReady = await waitForRedis(redis, 1000)
              if (redisReady) {
                /**
                 * INTENT COLLAPSE WINDOW IMPLEMENTATION:
                 * Rules (enforced in shouldEnqueueExternalSearch):
                 * 1. Allow only ONE external job within a 30-second window (via DB last_enqueued_at).
                 * 2. If a job for the same normalized_key is currently queued or running (BullMQ check).
                 * 3. Aggressive deduplication at queue layer using jobId = normalizedKey.
                 * 
                 * Outcome:
                  * - If rules pass: Enqueue job, return status 'resolving'.
                   * - If rules fail but job exists: Return status 'resolving' (Implicit attachment).
                   * - If rules fail and no job: Return status 'complete' (Silent failure/Rate limit).
                   */
                  const decision = await shouldEnqueueExternalSearch(normalizedKey, checkSourceQueue)
                  
                  if (decision.shouldEnqueue) {
                    const jobId = normalizedKey // Aggressive deduplication at queue layer
                    await checkSourceQueue.add('check-source', { 
                      query: queryStr, // Worker uses original query for better matching
                      normalizedKey,
                      intent, 
                      trigger: 'user_search', 
                      userId: user?.id, 
                      isPremium 
                    }, { 
                      jobId, 
                      priority: isPremium ? SEARCH_PRIORITY.CRITICAL : SEARCH_PRIORITY.STANDARD, 
                      removeOnComplete: true 
                    })
                    await markQueryEnqueued(normalizedKey)
                    status = 'resolving'
                      } else {
                        // Handle deferral for unhealthy queues
                        if (decision.reason === 'queue_unhealthy') {
                          console.warn(`[Search] Discovery fetch skipped due to queue overload: "${queryStr || normalizedKey}"`);
                          skipReason = 'queue_overload';
                          await markQueryDeferred(normalizedKey)
                          await deferSearchQuery(queryStr || normalizedKey, 'queue_unhealthy', isPremium, !!user)
                        }

                      // Implicit attachment: if a job is already in progress, tell the UI to wait
                    const existingJob = await checkSourceQueue.getJob(normalizedKey)
                    if (existingJob) {
                      status = 'resolving'
                    }
                  }

              }
            }

      } catch (e: any) { console.error("[Search] Discovery trigger error:", e.message) }
    }

    if (normalizedKey && !filters.cursor && (status === 'complete' || status === 'limit_reached')) {
      await setCachedSearchResult(normalizedKey, cacheFilters, { results: formattedResults, total: count ?? formattedResults.length, has_more: hasMore, next_cursor: nextCursor }, { ttlSeconds: formattedResults.length >= 5 ? 3600 : 300 })
    }

    recordSearchEvent({ normalized_query: normalizedKey || 'none', intent_type: normalizedKey ? 'TEXT' : 'FILTER', local_hit: formattedResults.length > 0, external_attempted: status === 'resolving', results_count: formattedResults.length, resolution_time_ms: Date.now() - startTime, status })
    const uniqueResults = Array.from(new Map(formattedResults.map((s: any) => [s.id, s])).values())
    return NextResponse.json({ status, results: uniqueResults, ...(count !== null && !filters.cursor && { total: count }), has_more: hasMore, next_cursor: nextCursor, filters_applied: cacheFilters, ...getDiscoveryInfo(status, uniqueResults, skipReason, !user) })
  } catch (error: any) { return handleApiError(error) }
}
