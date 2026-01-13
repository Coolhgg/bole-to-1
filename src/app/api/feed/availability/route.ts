import { prisma } from "@/lib/prisma"
import { NextRequest, NextResponse } from "next/server"
import { checkRateLimit, getClientIp, handleApiError, ApiError, ErrorCodes, parsePaginationParams } from "@/lib/api-utils"
import { AVAILABILITY_FEED_SQL, AVAILABILITY_FEED_COUNT_SQL } from "@/lib/feed-eligibility"

interface AvailabilityEventRow {
  event_id: string
  occurred_at: Date
  series_id: string
  series_title: string
  series_cover: string | null
  chapter_number: string
  source_name: string
  source_url: string
  scanlation_group: string | null
}

interface CountResult {
  total: bigint
}

export async function GET(request: NextRequest) {
  try {
    const ip = getClientIp(request);
    if (!await checkRateLimit(`feed-availability:${ip}`, 60, 60000)) {
      throw new ApiError("Too many requests. Please wait a moment.", 429, ErrorCodes.RATE_LIMITED);
    }

    const { searchParams } = new URL(request.url);
    const { limit, offset } = parsePaginationParams(searchParams);

    const rawResults = await prisma.$queryRawUnsafe(AVAILABILITY_FEED_SQL, limit + 1, offset) as AvailabilityEventRow[];
    const countResult = await prisma.$queryRawUnsafe(AVAILABILITY_FEED_COUNT_SQL) as CountResult[];

    const hasMore = rawResults.length > limit;
    const results = hasMore ? rawResults.slice(0, -1) : rawResults;
    const total = Number(countResult[0]?.total || 0);

    const items = results.map((row: AvailabilityEventRow) => ({
      event_id: row.event_id,
      occurred_at: row.occurred_at.toISOString(),
      series: {
        id: row.series_id,
        title: row.series_title,
        cover_url: row.series_cover,
      },
      chapter: {
        id: `${row.series_id}-${row.chapter_number}`, // Virtual ID since we group by number
        number: Number(row.chapter_number),
        display: row.chapter_number,
      },
      source: {
        name: row.source_name,
        url: row.source_url,
        group: row.scanlation_group,
      },
    }));

    return NextResponse.json({
      feed_type: 'availability_events',
      results: items,
      total,
      has_more: hasMore,
      pagination: {
        limit,
        offset,
        next_offset: hasMore ? offset + limit : null,
      }
    });

  } catch (error: unknown) {
    return handleApiError(error);
  }
}
