import { prisma } from "@/lib/prisma"
import { createClient } from "@/lib/supabase/server"
import { NextRequest, NextResponse } from "next/server"
import { checkRateLimit, getClientIp, handleApiError, ApiError, ErrorCodes } from "@/lib/api-utils"
import { PRODUCTION_QUERIES } from "@/lib/sql/production-queries"

export async function GET(request: NextRequest) {
  try {
    const ip = getClientIp(request);
    if (!await checkRateLimit(`feed-updates:${ip}`, 60, 60000)) {
      throw new ApiError("Too many requests. Please wait a moment.", 429, ErrorCodes.RATE_LIMITED);
    }

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      throw new ApiError("Unauthorized", 401, ErrorCodes.UNAUTHORIZED);
    }

    const { searchParams } = new URL(request.url);
    const cursor = searchParams.get("cursor");
    const limit = Math.min(parseInt(searchParams.get("limit") || "20"), 50);
    const unseenOnly = searchParams.get("unseen_only") === "true";

    // 1. Fetch User Settings
    const userProfile = await prisma.user.findUnique({
      where: { id: user.id },
      select: {
        safe_browsing_mode: true,
        default_source: true,
        feed_last_seen_at: true,
      }
    });

    if (!userProfile) throw new ApiError("User profile not found", 404, ErrorCodes.NOT_FOUND);

    const feedLastSeenAt = userProfile.feed_last_seen_at || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // 2. Fetch Default Filter (for language preference) - use Prisma to avoid Supabase table not existing
    const preferredLanguages: string[] = [];
    try {
      // This is a user setting that may or may not exist
      const defaultSource = userProfile.default_source;
      // For now, use empty array - this can be expanded when saved_filters is properly set up
    } catch (e) {
      // Ignore if saved_filters table doesn't exist
    }

    // 3. Define Allowed Content Ratings based on safe browsing mode
    const allowedRatings = ['safe', 'suggestive'];
    if (userProfile.safe_browsing_mode === 'suggestive' || userProfile.safe_browsing_mode === 'sfw_plus') {
      allowedRatings.push('erotica');
    }
    if (userProfile.safe_browsing_mode === 'nsfw') {
      allowedRatings.push('erotica', 'pornographic');
    }

    // 4. Cursor date for pagination
    const cursorDate = cursor ? new Date(cursor) : undefined;

    // 5. Fetch Updates (using optimized SQL to join library and feed)
    const rawUpdates = await prisma.$queryRawUnsafe<any[]>(
      PRODUCTION_QUERIES.USER_UPDATES_FEED,
      user.id,
      limit + 1
    );

    if (rawUpdates.length === 0) {
      return NextResponse.json({ updates: [], next_cursor: null, has_more: false });
    }

    const eligibleSeriesIds = rawUpdates.map(u => u.series_id);
    const libraryEntries = await prisma.libraryEntry.findMany({
      where: {
        user_id: user.id,
        series_id: { in: eligibleSeriesIds }
      },
      select: { series_id: true, preferred_source: true }
    });
    const preferredSourceMap = new Map(libraryEntries.map(e => [e.series_id, e.preferred_source]));

    // 6. Fetch Full Data for the updates using correct model name
    const logicalChapters = await prisma.chapter.findMany({
      where: {
        id: { in: rawUpdates.map(u => u.id) }
      },
      include: {
        series: {
          select: {
            id: true,
            title: true,
            cover_url: true,
            content_rating: true,
            status: true
          }
        },
        sources: {
          where: { 
            is_available: true,
            ...(preferredLanguages.length > 0 && {
              language: { in: preferredLanguages }
            })
          },
          include: {
            series_source: {
              select: {
                id: true,
                source_name: true,
                source_url: true,
                trust_score: true,
              },
            },
          },
        },
      },
    });

    // 7. Re-sort logicalChapters based on the ranked rawUpdates order
    const rankedChapters = rawUpdates.map(raw => 
      logicalChapters.find(lc => lc.id === raw.id)
    ).filter(Boolean) as (typeof logicalChapters[0])[];

    const hasMore = rankedChapters.length > limit;
    const items = hasMore ? rankedChapters.slice(0, -1) : rankedChapters;
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].first_detected_at.toISOString() : null;

    return NextResponse.json({
      updates: items.map((lc) => {
        const seriesPreferredSource = lc.series_id ? preferredSourceMap.get(lc.series_id) : null;
        const globalDefaultSource = userProfile.default_source;
        const preferredSource = seriesPreferredSource || globalDefaultSource;
        
        // Sorting logic for sources within a chapter
        const sortedSources = [...lc.sources].sort((a, b) => {
          // 1. Preferred source match
          const aIsPreferred = a.series_source.source_name === preferredSource;
          const bIsPreferred = b.series_source.source_name === preferredSource;
          if (aIsPreferred && !bIsPreferred) return -1;
          if (!aIsPreferred && bIsPreferred) return 1;

          // 2. Language match (if multiple preferred languages, first in list)
          if (preferredLanguages.length > 1) {
            const aLangIdx = preferredLanguages.indexOf(a.language || "");
            const bLangIdx = preferredLanguages.indexOf(b.language || "");
            if (aLangIdx !== -1 && bLangIdx !== -1) return aLangIdx - bLangIdx;
            if (aLangIdx !== -1) return -1;
            if (bLangIdx !== -1) return 1;
          }

          // 3. Trust score
          return Number(b.series_source.trust_score) - Number(a.series_source.trust_score);
        });

        const primarySource = sortedSources[0];

        return {
          id: lc.id,
          series: lc.series,
          chapter_number: Number(lc.chapter_number),
          chapter_title: lc.chapter_title,
          volume_number: lc.volume_number,
          published_at: lc.published_at?.toISOString() || null,
          discovered_at: lc.first_detected_at.toISOString(),
          sources: sortedSources.map(s => ({
            id: s.id,
            chapter_url: s.source_chapter_url,
            scanlation_group: s.scanlation_group,
            language: s.language,
            source: {
              id: s.series_source.id,
              name: s.series_source.source_name,
              url: s.series_source.source_url,
              trust_score: Number(s.series_source.trust_score),
            }
          })),
          primary_source: primarySource ? {
            id: primarySource.id,
            chapter_url: primarySource.source_chapter_url,
            source_name: primarySource.series_source.source_name,
            language: primarySource.language,
            is_preferred: primarySource.series_source.source_name === preferredSource,
            is_fallback: primarySource.series_source.source_name !== preferredSource && !!preferredSource
          } : null
        };
      }),
      next_cursor: nextCursor,
      has_more: hasMore,
    });

  } catch (error: any) {
    return handleApiError(error);
  }
}
