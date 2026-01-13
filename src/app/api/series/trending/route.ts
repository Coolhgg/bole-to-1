import { supabaseAdmin } from "@/lib/supabase/admin"
import { NextRequest, NextResponse } from "next/server"
import { checkRateLimit, handleApiError, getClientIp } from "@/lib/api-utils"
import { getBestCoversBatch, isValidCoverUrl } from "@/lib/cover-resolver"

const VALID_PERIODS = ['day', 'week', 'month', 'all'] as const
const VALID_TYPES = ['manga', 'manhwa', 'manhua', 'webtoon'] as const

// Dead manga threshold: No chapters in 90 days
const DEAD_MANGA_DAYS = 90

// Trending score weights (Kenmei formula)
const FORMULA = {
  ACTIVITY_WEIGHT: 0.6,
  FOLLOWERS_WEIGHT: 0.3,
  VELOCITY_WEIGHT: 0.1
}

type Period = typeof VALID_PERIODS[number]

function getPeriodInterval(period: Period): number {
  switch (period) {
    case 'day': return 1
    case 'week': return 7
    case 'month': return 30
    case 'all': return 365
  }
}

export async function GET(request: NextRequest) {
  const ip = getClientIp(request);
  if (!await checkRateLimit(`trending:${ip}`, 60, 60000)) {
    return NextResponse.json(
      { error: 'Too many requests. Please wait a moment.' },
      { status: 429 }
    )
  }

  const searchParams = request.nextUrl.searchParams
  const period = (searchParams.get('period') || 'week') as Period
  const type = searchParams.get('type')
  const limit = Math.min(Math.max(1, parseInt(searchParams.get('limit') || '20')), 50)
  const offset = Math.max(0, parseInt(searchParams.get('offset') || '0'))

  if (!VALID_PERIODS.includes(period)) {
    return NextResponse.json(
      { error: 'Invalid period. Must be one of: day, week, month, all' },
      { status: 400 }
    )
  }

    try {
      const periodDays = getPeriodInterval(period)
      const cutoffDate = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString()
      const deadCutoff = new Date(Date.now() - DEAD_MANGA_DAYS * 24 * 60 * 60 * 1000).toISOString()

      // Optimized Step: Use a single query to get aggregated scores and series data
      // We only care about series with activity OR top followed series
      // This reduces the data transferred and processed in memory
      
      const { data: trendingData, error } = await supabaseAdmin.rpc('get_trending_series_v2', {
        p_cutoff_date: cutoffDate,
        p_dead_cutoff: deadCutoff,
        p_type: type || null,
        p_limit: 100, // Fetch more to allow for secondary sorting
        p_offset: 0
      })

      if (error) throw error

      const paginatedSeries = trendingData.slice(offset, offset + limit)
      const seriesIds = paginatedSeries.map((s: any) => s.id)
      const bestCovers = await getBestCoversBatch(seriesIds)

      return NextResponse.json({
        results: paginatedSeries.map((s: any) => {
          const bestCover = bestCovers.get(s.id)
          const fallbackCover = isValidCoverUrl(s.cover_url) ? s.cover_url : null
          return {
            ...s,
            cover_url: bestCover?.cover_url || fallbackCover,
          }
        }),
        total: trendingData.length,
        limit,
        offset,
        period,
        has_more: offset + paginatedSeries.length < trendingData.length
      })

    } catch (error: any) {

    return handleApiError(error)
  }
}
