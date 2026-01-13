import { prisma } from "@/lib/prisma"
import { NextRequest, NextResponse } from "next/server"
import { checkRateLimit, getClientIp, handleApiError, ApiError, ErrorCodes } from "@/lib/api-utils"
import { createClient } from "@/lib/supabase/server"
import { redisApi, REDIS_KEY_PREFIX } from "@/lib/redis"

interface ActivityEventRow {
  id: string;
  series_id: string;
  series_title: string;
  series_thumbnail: string | null;
  chapter_id: string;
  chapter_number: string;
  chapter_type: string;
  chapter_title: string | null;
  volume_number: number | null;
  source_id: string;
  source_name: string;
  source_url: string;
  event_type: string;
  discovered_at: Date;
}

export async function GET(request: NextRequest) {
  try {
    const ip = getClientIp(request);
    if (!await checkRateLimit(`feed-activity:${ip}`, 60, 60000)) {
      throw new ApiError("Too many requests. Please wait a moment.", 429, ErrorCodes.RATE_LIMITED);
    }

    const { searchParams } = new URL(request.url);
    const cursorStr = searchParams.get("cursor");
    const limit = Math.min(parseInt(searchParams.get("limit") || "30"), 100);
    const filter = searchParams.get("filter") || "all";

    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ entries: [], next_cursor: null, has_more: false });
    }

    // 1. Caching Layer
    const versionKey = `${REDIS_KEY_PREFIX}feed:v:${user.id}`;
    let version = await redisApi.get(versionKey);
    if (!version) {
      version = "1";
      await redisApi.set(versionKey, version);
    }

    const cacheKey = `${REDIS_KEY_PREFIX}feed:act:${user.id}:v${version}:${filter}:${cursorStr || 'initial'}:${limit}`;
    const cached = await redisApi.get(cacheKey);
    if (cached) {
      return NextResponse.json(JSON.parse(cached));
    }

    // 2. Fetch from DB if cache miss
    // Get last seen timestamp for "New" badge logic
    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { feed_last_seen_at: true }
    });
    const feedLastSeenAt = dbUser?.feed_last_seen_at || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Decode cursor
    let cursorData: { d: string, i: string } | null = null;
    if (cursorStr) {
      try {
        cursorData = JSON.parse(Buffer.from(cursorStr, 'base64').toString());
      } catch (e) {
        console.error("Invalid cursor:", e);
      }
    }

    const params: any[] = [user.id];
    let query = `
      SELECT *
      FROM availability_events
      WHERE user_id = $1::uuid
    `;

    // Apply unread filter if requested
    if (filter === "unread") {
      query += `
        AND NOT EXISTS (
          SELECT 1 FROM user_chapter_read_v2
          WHERE user_id = $1::uuid
          AND chapter_id = availability_events.chapter_id
        )
      `;
    }

    if (cursorData) {
      query += `
        AND (
          discovered_at < $${params.length + 1}::timestamptz 
          OR (discovered_at = $${params.length + 1}::timestamptz AND id < $${params.length + 2}::uuid)
        )
      `;
      params.push(cursorData.d, cursorData.i);
    }

    query += `
      ORDER BY discovered_at DESC, id DESC
      LIMIT $${params.length + 1}
    `;
    params.push(limit + 1);

    const events = await prisma.$queryRawUnsafe<ActivityEventRow[]>(query, ...params);

    const hasMore = events.length > limit;
    const items = hasMore ? events.slice(0, -1) : events;
    
    // Generate next cursor
    const nextCursor = hasMore && items.length > 0 
      ? Buffer.from(JSON.stringify({
          d: items[items.length - 1].discovered_at.toISOString(),
          i: items[items.length - 1].id
        })).toString('base64')
      : null;

    // Fetch read status in a separate query to adhere to "No joins at request time" for the main event query
    const chapterIds = Array.from(new Set(items.map(e => e.chapter_id)));
    const readChapters = await prisma.userChapterReadV2.findMany({
      where: {
        user_id: user.id,
        chapter_id: { in: chapterIds }
      },
      select: { chapter_id: true }
    });
    const readSet = new Set(readChapters.map(rc => rc.chapter_id));

    const response = {
      entries: items.map((event) => ({
        id: event.id,
        series: {
          id: event.series_id,
          title: event.series_title,
          cover_url: event.series_thumbnail,
          content_rating: null,
          status: null,
          type: 'manga',
        },
        chapter_number: Number(event.chapter_number),
        chapter_title: event.chapter_title,
        volume_number: event.volume_number,
        is_unseen: new Date(event.discovered_at) > feedLastSeenAt,
        is_read: readSet.has(event.chapter_id),
        sources: [{
          name: event.source_name,
          url: event.source_url,
          discovered_at: event.discovered_at.toISOString(),
        }],
        first_discovered_at: event.discovered_at.toISOString(),
        last_updated_at: event.discovered_at.toISOString(),
      })),
      next_cursor: nextCursor,
      has_more: hasMore,
    };

    // Cache the response for 60 seconds
    await redisApi.set(cacheKey, JSON.stringify(response), 'EX', 60);

    return NextResponse.json(response);
  } catch (error) {
    return handleApiError(error);
  }
}
