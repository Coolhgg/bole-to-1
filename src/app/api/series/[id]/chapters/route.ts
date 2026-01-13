import { prisma, withRetry } from "@/lib/prisma"
import { NextRequest, NextResponse } from "next/server"
import { checkRateLimit, getClientIp, handleApiError, ApiError, ErrorCodes } from "@/lib/api-utils"
import { scrapers } from "@/lib/scrapers"
import { createClient } from "@/lib/supabase/server"
import { Prisma } from "@prisma/client"
import { syncChapters } from "@/lib/series-sync"
import { getUserSourcePreferences } from "@/lib/source-utils"
import { sortSourcesWithPreferences } from "@/lib/source-utils-shared"

// v2.1.1 - Added comment to force recompile and fix zombie BuildError
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ip = getClientIp(request);
    if (!await checkRateLimit(`chapters:${ip}`, 60, 60000)) {
      throw new ApiError("Too many requests. Please wait a moment.", 429, ErrorCodes.RATE_LIMITED);
    }

    const { id } = await params
    const { searchParams } = new URL(request.url)
    const sourceFilter = searchParams.get("source")
    const sortBy = searchParams.get("sort") || "chapter_desc"
    const page = parseInt(searchParams.get("page") || "1")
    const limit = Math.min(parseInt(searchParams.get("limit") || "50"), 100)
    const grouped = searchParams.get("grouped") !== "false"

    if (!UUID_REGEX.test(id)) {
      throw new ApiError("Invalid series ID format", 400, ErrorCodes.VALIDATION_ERROR)
    }

    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()

    // 1. Initial Fetch
    let { total, chapters } = await fetchChapters(id, {
      sourceFilter,
      sortBy,
      page,
      limit,
      grouped
    });

    // 2. On-demand Sync (If empty and first page)
    if (total === 0 && page === 1) {
      await performOnDemandSync(id);
      
      // Re-fetch after sync
      const refreshed = await fetchChapters(id, {
        sourceFilter,
        sortBy,
        page,
        limit,
        grouped
      });
      total = refreshed.total;
      chapters = refreshed.chapters;
    }

    // 3. User Read Status and Source Preferences
    let readChapterIds: Set<string> = new Set()
    let lastReadChapter: number = -1
    let sourcePreferences: any = { globalPriorities: new Map() }

    if (user) {
      const [readChapters, libraryEntry, prefs] = await Promise.all([
        prisma.userChapterReadV2.findMany({
          where: {
            user_id: user.id,
            chapter: { series_id: id },
          },
          select: { chapter_id: true },
        }),
        prisma.libraryEntry.findFirst({
          where: {
            user_id: user.id,
            series_id: id,
          },
          select: { last_read_chapter: true },
        }),
        getUserSourcePreferences(user.id, id),
      ])

      readChapterIds = new Set(readChapters.map(r => r.chapter_id))
      lastReadChapter = libraryEntry?.last_read_chapter ? Number(libraryEntry.last_read_chapter) : -1
      sourcePreferences = prefs
    }

      // 4. Formatting and Formatting Sources
      const formattedChapters = chapters.map((c: any) => {
        const num = Number(c.chapter_number);
        const logicalId = grouped ? c.id : c.chapter_id;
        const isRead = readChapterIds.has(logicalId) || num <= lastReadChapter;
        
        const sources = grouped ? (c.sources || []) : [{
          id: c.id,
          source_name: c.source_name,
          source_id: c.source_id,
          chapter_url: c.source_url,
          trust_score: c.trust_score,
          is_available: c.is_available,
          published_at: c.published_at,
          detected_at: c.detected_at
        }];

        const sortedSources = sortSourcesWithPreferences(sources, sourcePreferences);
        
        if (grouped) {
          return {
            ...c,
            chapter_number: num,
            is_read: isRead,
            sources: sortedSources,
            latest_upload: c.published_at?.toISOString() || c.first_detected_at?.toISOString() || null,
          };
        } else {
          const topSource = sortedSources[0] || sources[0];
          return {
            ...c,
            chapter_number: num,
            is_read: isRead,
            source_name: topSource.source_name,
            source_url: topSource.chapter_url || topSource.source_url,
            trust_score: topSource.trust_score,
          };
        }
      });

    return NextResponse.json({
      chapters: formattedChapters,
      total,
      page,
      limit,
      total_pages: Math.ceil(total / limit),
      grouped,
    })
  } catch (error: unknown) {
    return handleApiError(error);
  }
}

async function fetchChapters(seriesId: string, options: any) {
    const { sourceFilter, sortBy, page, limit, grouped } = options;
    const skip = (page - 1) * limit;
  
      if (grouped) {
        const logicalWhere: Prisma.ChapterWhereInput = { 
          series_id: seriesId,
          deleted_at: null
        }
        const total = await prisma.chapter.count({ where: logicalWhere })
      
      const chaptersList = await withRetry(() => 
        prisma.chapter.findMany({
          where: logicalWhere,

        orderBy: sortBy === "discovered_desc" 
          ? { first_detected_at: "desc" }
          : sortBy === "published_desc"
          ? { published_at: "desc" }
          : { chapter_number: "desc" },
        take: limit,
        skip,
          include: {
            sources: {
              where: sourceFilter ? {
                series_source: { source_name: sourceFilter }
              } : undefined,
              include: {
                series_source: {
                  select: {
                    id: true,
                    source_name: true,
                    source_id: true,
                    trust_score: true,
                  },
                },
              },
            },
          },
        })
      )
  
      return {
        total,
        chapters: chaptersList.map(lc => ({
          id: lc.id,
          chapter_number: Number(lc.chapter_number),
          chapter_title: lc.chapter_title,
          volume_number: lc.volume_number,
          published_at: lc.published_at,
          first_detected_at: lc.first_detected_at,
          sources: lc.sources.map(s => ({
            id: s.id,
            source_name: s.series_source.source_name,
            source_id: s.series_source.source_id,
            chapter_url: s.source_chapter_url,
            published_at: s.source_published_at?.toISOString() || null,
            detected_at: s.detected_at.toISOString(),
            is_available: s.is_available,
            trust_score: Number(s.series_source.trust_score),
          })),
        }))
      };
    } else {
      const sourceWhere: Prisma.ChapterSourceWhereInput = {
        chapter: { 
          series_id: seriesId,
          deleted_at: null
        },
        series_source: sourceFilter ? { source_name: sourceFilter } : undefined
      }
  
      const total = await prisma.chapterSource.count({ where: sourceWhere })
  
      const chapterSources = await withRetry(() =>
        prisma.chapterSource.findMany({
          where: sourceWhere,
          orderBy: sortBy === "discovered_desc"
            ? { detected_at: "desc" }
            : sortBy === "published_desc"
            ? { source_published_at: "desc" }
            : { chapter: { chapter_number: "desc" } },
          take: limit,
          skip,
          include: {
            chapter: {
              select: {
                id: true,
                chapter_number: true,
                chapter_title: true,
                volume_number: true,
              }
            },
            series_source: {
              select: {
                id: true,
                source_name: true,
                source_id: true,
                trust_score: true,
              }
            }
          }
        })
      )
  
      return {
        total,
        chapters: chapterSources.map(s => ({
          id: s.id,
          chapter_id: s.chapter.id,
          chapter_number: Number(s.chapter.chapter_number),
          chapter_title: s.chapter_title || s.chapter.chapter_title,
          volume_number: s.chapter.volume_number,
          chapter_url: s.source_chapter_url,
          published_at: s.source_published_at?.toISOString() || null,
          detected_at: s.detected_at.toISOString(),
          is_available: s.is_available,
          source_name: s.series_source.source_name,
          source_id: s.series_source.source_id,
          trust_score: Number(s.series_source.trust_score),
        }))
      };

  }
}

async function performOnDemandSync(seriesId: string) {
  // Use a session-level advisory lock to prevent concurrent scrapes
  const lockId = parseInt(seriesId.replace(/-/g, '').substring(0, 8), 16)
  
  try {
    const lockAcquired = await prisma.$queryRawUnsafe<{ pg_try_advisory_lock: boolean }[]>(
      `SELECT pg_try_advisory_lock(${lockId})`
    );

    if (!lockAcquired[0].pg_try_advisory_lock) {
      console.log(`[Sync] Series ${seriesId} is already being synced, skipping.`);
      return;
    }

      try {
        const currentCount = await prisma.chapter.count({ 
          where: { 
            series_id: seriesId,
            deleted_at: null
          } 
        });
      
      const series = await prisma.series.findUnique({
        where: { id: seriesId },
        include: { sources: true }
      });

      if (!series) return;

      // Ensure we use 'let' for syncSource as it may be reassigned via upsert
      let syncSource = series.sources.find(s => s.source_name === 'mangadex') || series.sources[0];
      
      if (!syncSource && series.mangadex_id) {
        console.log(`[Sync] Creating on-the-fly SeriesSource for ${seriesId} (${series.mangadex_id})`);
        syncSource = await prisma.seriesSource.upsert({
          where: {
            source_name_source_id: {
              source_name: 'mangadex',
              source_id: series.mangadex_id
            }
          },
          update: { series_id: seriesId },
          create: {
            series_id: seriesId,
            source_name: 'mangadex',
            source_id: series.mangadex_id,
            source_url: `https://mangadex.org/title/${series.mangadex_id}`,
            source_title: series.title,
            sync_priority: 'COLD'
          }
        });
      }

      if (!syncSource) {
        console.log(`[Sync] No source found for series ${seriesId}, and no mangadex_id available.`);
        return;
      }

      let isDummy = false;
      if (currentCount === 3) {
        const existingChapters = await prisma.chapter.findMany({
          where: { series_id: seriesId },
          select: { chapter_title: true }
        });
        const dummyTitles = ["The Beginning", "The Journey", "New Discovery"];
        isDummy = existingChapters.every(c => dummyTitles.includes(c.chapter_title || ""));
      }

      if (currentCount > 0 && !isDummy) {
        console.log(`[Sync] Series ${seriesId} already has ${currentCount} real chapters, skipping on-demand sync.`);
        return;
      }

      // Sync via the identified syncSource
      if (scrapers[syncSource.source_name]) {
        console.log(`[Sync] Performing on-demand sync for ${series.title} via ${syncSource.source_name}`);
        const scraped = await scrapers[syncSource.source_name].scrapeSeries(syncSource.source_id);
        
        if (scraped.chapters.length > 0) {
          await syncChapters(seriesId, syncSource.source_id, syncSource.source_name, scraped.chapters);
        }
      }
    } finally {
      await prisma.$executeRawUnsafe(`SELECT pg_advisory_unlock(${lockId})`);
    }
  } catch (err) {
    console.error(`[Sync] On-demand sync failed for ${seriesId}:`, err);
  }
}
