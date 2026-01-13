/**
 * Production-level optimized SQL queries for core project features.
 */

export const PRODUCTION_QUERIES = {
  /**
   * Library Progress Dashboard
   * Retrieves a user's active library with unread chapter counts.
   * UPDATED: Now calculates unread_count based on logical chapters not present in user_chapter_reads_v2,
   * providing a true chapter-based count that handles gaps.
   */
    LIBRARY_PROGRESS: `
        SELECT 
            le.id, 
            s.id as series_id,
            s.title, 
            s.cover_url, 
            le.last_read_chapter,
            (SELECT MAX(lc.chapter_number) FROM logical_chapters lc WHERE lc.series_id::uuid = s.id::uuid AND lc.deleted_at IS NULL) AS latest_chapter,
            COUNT(lc.id) FILTER (
                WHERE lc.deleted_at IS NULL 
                AND NOT EXISTS (
                    SELECT 1 FROM user_chapter_reads_v2 ucr 
                    WHERE ucr.chapter_id = lc.id AND ucr.user_id = le.user_id
                )
                -- Optional: Only count chapters up to the latest one, or all available ones
            ) AS unread_count
        FROM library_entries le
        JOIN series s ON le.series_id::uuid = s.id::uuid
        LEFT JOIN logical_chapters lc ON lc.series_id::uuid = s.id::uuid
        WHERE le.user_id = $1::uuid 
          AND le.status = 'reading'
          AND le.deleted_at IS NULL
          AND s.deleted_at IS NULL
        GROUP BY le.id, s.id;
      `,


    /**
     * Advanced Series Discovery (Safe Browsing)
     * Search for series with strict content rating filters.
     */
      SERIES_DISCOVERY: `
        SELECT 
          id, 
          title::text as title, 
          alternative_titles::text as alternative_titles, 
          cover_url::text as cover_url, 
          type::text as type, 
          status::text as status, 
          genres::text[] as genres, 
          content_rating::text as content_rating, 
          total_follows::integer as total_follows
        FROM series 
        WHERE (title ILIKE '%' || $1::text || '%' OR alternative_titles::text ILIKE '%' || $1::text || '%')
          AND (
            $2::varchar[] IS NULL OR genres @> $2::varchar[]
          )
          AND (
            ($3::text = 'sfw' AND (content_rating IS NULL OR content_rating IN ('safe', 'suggestive'))) OR
            ($3::text = 'questionable' AND (content_rating IS NULL OR content_rating IN ('safe', 'suggestive', 'questionable'))) OR
            ($3::text = 'nsfw')
          )
          AND deleted_at IS NULL
          ORDER BY total_follows DESC
          LIMIT $4::integer;
        `,

      /**
       * Personalized Updates Feed
       * Recent chapter updates for series in user's library.
       * Tiered ranking logic:
       * 1. Recency Bucket (Day)
       * 2. Read State (Unread > Read)
       * 3. Library Status (Reading > On Hold > Planning > Other)
       * 4. Sync Priority (High > Warm > Cold)
       * 5. Source Match (Preferred > Other)
       */
      USER_UPDATES_FEED: `
          SELECT 
              fe.id, 
              s.id as series_id,
              s.title, 
              s.cover_url,
              fe.chapter_number, 
              fe.first_discovered_at,
              -- Ranking Signals
              (CASE WHEN EXISTS (
                  SELECT 1 FROM user_chapter_reads_v2 ucr 
                  WHERE ucr.chapter_id = fe.logical_chapter_id AND ucr.user_id = $1::uuid
              ) THEN 0 ELSE 1 END) as is_unread,
              (CASE le.status 
                  WHEN 'reading' THEN 3 
                  WHEN 'on_hold' THEN 2 
                  WHEN 'planning' THEN 1 
                  ELSE 0 
              END) as library_status_score,
              (CASE le.sync_priority 
                  WHEN 'HIGH' THEN 2 
                  WHEN 'WARM' THEN 1 
                  ELSE 0 
              END) as sync_priority_score,
              (CASE WHEN EXISTS (
                  SELECT 1 FROM user_series_source_preferences ussp
                  WHERE ussp.user_id = $1::uuid 
                    AND ussp.series_id::uuid = s.id::uuid
                    AND ussp.source_name::text = ANY(SELECT jsonb_array_elements_text(fe.sources))
              ) THEN 1 ELSE 0 END) as source_match_score
          FROM feed_entries fe
          JOIN series s ON fe.series_id::uuid = s.id::uuid
          JOIN library_entries le ON le.series_id::uuid = s.id::uuid
          WHERE le.user_id = $1::uuid
            AND le.deleted_at IS NULL
            AND s.deleted_at IS NULL
            AND ($3::timestamptz IS NULL OR fe.first_discovered_at < $3::timestamptz)
          ORDER BY 
              date_trunc('day', fe.first_discovered_at) DESC,
              is_unread DESC,
              library_status_score DESC,
              sync_priority_score DESC,
              source_match_score DESC,
              fe.first_discovered_at DESC,
              fe.id ASC
          LIMIT $2::integer;
        `,

    /**
     * Personalized Updates Feed
     * Recent chapter updates for series in user's library.
     * Tiered ranking logic:
     * 1. Recency Bucket (Day)
     * 2. Read State (Unread > Read)
     * 3. Library Status (Reading > On Hold > Planning > Other)
     * 4. Sync Priority (High > Warm > Cold)
     * 5. Source Match (Preferred > Other)
     */
    USER_UPDATES_FEED: `
        SELECT 
            fe.id, 
            s.id as series_id,
            s.title, 
            s.cover_url,
            fe.chapter_number, 
            fe.first_discovered_at,
            -- Ranking Signals
            (CASE WHEN EXISTS (
                SELECT 1 FROM user_chapter_reads_v2 ucr 
                WHERE ucr.chapter_id = fe.logical_chapter_id AND ucr.user_id = $1::uuid
            ) THEN 0 ELSE 1 END) as is_unread,
            (CASE le.status 
                WHEN 'reading' THEN 3 
                WHEN 'on_hold' THEN 2 
                WHEN 'planning' THEN 1 
                ELSE 0 
            END) as library_status_score,
            (CASE le.sync_priority 
                WHEN 'HIGH' THEN 2 
                WHEN 'WARM' THEN 1 
                ELSE 0 
            END) as sync_priority_score,
            (CASE WHEN EXISTS (
                SELECT 1 FROM user_series_source_preferences ussp
                WHERE ussp.user_id = $1::uuid 
                  AND ussp.series_id::uuid = s.id::uuid
                  AND ussp.source_name::text = ANY(SELECT jsonb_array_elements_text(fe.sources))
            ) THEN 1 ELSE 0 END) as source_match_score
        FROM feed_entries fe
        JOIN series s ON fe.series_id::uuid = s.id::uuid
        JOIN library_entries le ON le.series_id::uuid = s.id::uuid
        WHERE le.user_id = $1::uuid
          AND le.deleted_at IS NULL
          AND s.deleted_at IS NULL
        ORDER BY 
            date_trunc('day', fe.first_discovered_at) DESC,
            is_unread DESC,
            library_status_score DESC,
            sync_priority_score DESC,
            source_match_score DESC,
            fe.first_discovered_at DESC,
            fe.id ASC
        LIMIT $2::integer;
      `,


    /**
     * Import Job Result Aggregation
     * Summary stats for an import job.
     */
        IMPORT_JOB_SUMMARY: `
          SELECT 
              status,
              reason_code,
              COUNT(*) as item_count
          FROM import_items
          WHERE job_id = $1::uuid
          GROUP BY status, reason_code
          ORDER BY status ASC;
        `,

        /**
         * Series with multiple sources
         */
        MULTIPLE_SOURCES: `
          SELECT series_id
          FROM series_sources
          GROUP BY series_id
          HAVING COUNT(DISTINCT source_name) >= 2;
        `,

        /**
         * Kenmei-style Chapter Timeline

       * Groups multiple sources under the same logical chapter, ordered by discovery time.
       */
      CHAPTER_TIMELINE: `
        SELECT 
            c.id, 
            c.chapter_number, 
            c.chapter_title, 
            c.series_id,
            s.title as series_title, 
            s.cover_url,
            jsonb_agg(
                jsonb_build_object(
                    'id', cs.id,
                    'source_name', cs.source_name,
                    'source_url', cs.source_chapter_url,
                    'discovered_at', cs.detected_at
                ) ORDER BY cs.detected_at ASC
            ) as sources,
            MAX(cs.detected_at) as latest_discovery,
            EXISTS(
                SELECT 1 FROM user_chapter_reads_v2 ucr 
                WHERE ucr.chapter_id = c.id AND ucr.user_id = $1::uuid
            ) as is_read
        FROM logical_chapters c
        JOIN series s ON c.series_id::uuid = s.id::uuid
        JOIN chapter_sources cs ON c.id = cs.chapter_id
        WHERE c.deleted_at IS NULL
          AND s.deleted_at IS NULL
        GROUP BY c.id, s.id
        ORDER BY latest_discovery DESC
        LIMIT $2::integer OFFSET $3::integer;
      `,

      /**
       * Chapter Details with Sources
       */
      CHAPTER_DETAILS: `
        SELECT 
            c.*,
            jsonb_agg(
                jsonb_build_object(
                    'source_name', cs.source_name,
                    'source_url', cs.source_chapter_url,
                    'discovered_at', cs.detected_at
                ) ORDER BY cs.detected_at ASC
            ) as sources
        FROM logical_chapters c
        LEFT JOIN chapter_sources cs ON c.id = cs.chapter_id
        WHERE c.id = $1::uuid
          AND c.deleted_at IS NULL
        GROUP BY c.id;
      `,

        /**
         * Chapter Read Status
         */
        CHAPTER_READ_STATUS: `
          SELECT 
              ucr.read_at,
              TRUE as is_read
          FROM user_chapter_reads_v2 ucr
          WHERE ucr.user_id = $1::uuid AND ucr.chapter_id = $2::uuid;
        `,

        /**
         * Real-time Activity Feed (Kenmei Logic)
         * Groups multiple sources under the same logical chapter, ordered by discovery events.
         */
        REALTIME_UPDATES_FEED: `
          WITH latest_chapter_activity AS (
            SELECT 
              chapter_id, 
              MAX(created_at) as latest_event_at
            FROM activity_events
            WHERE event_type = 'chapter_source_added'
            GROUP BY chapter_id
          )
          SELECT
            lc.id as chapter_id,
            s.title as series_title,
            s.cover_url,
            lc.chapter_number,
            lca.latest_event_at as activity_at,
            jsonb_agg(
              jsonb_build_object(
                'source_name', cs.source_name,
                'source_url', cs.source_chapter_url,
                'detected_at', cs.detected_at
              ) ORDER BY cs.detected_at DESC
            ) as available_sources
          FROM latest_chapter_activity lca
          JOIN logical_chapters lc ON lca.chapter_id = lc.id
          JOIN series s ON lc.series_id::uuid = s.id::uuid
          JOIN chapter_sources cs ON lc.id = cs.chapter_id
          WHERE cs.is_available = true
          GROUP BY lc.id, s.id, lc.chapter_number, lca.latest_event_at
          ORDER BY activity_at DESC
          LIMIT $1::integer;
        `,

        /**
         * User Activity Feed

       * Chronological activity for user and their followings.
       */
      ACTIVITY_FEED: `
        SELECT 
          a.id, a.type, a.metadata, a.created_at,
          u.username, u.avatar_url,
          s.title as series_title,
          lc.chapter_number
        FROM activities a
        JOIN users u ON a.user_id::uuid = u.id::uuid
        LEFT JOIN series s ON a.series_id::uuid = s.id::uuid
        LEFT JOIN logical_chapters lc ON a.logical_chapter_id::uuid = lc.id::uuid
        WHERE (
          a.user_id = $1::uuid 
          OR EXISTS (SELECT 1 FROM follows f WHERE f.following_id::uuid = a.user_id::uuid AND f.follower_id = $1::uuid)
        )
        AND u.deleted_at IS NULL
        ORDER BY a.created_at DESC
        LIMIT $2::integer;
      `,

        /**
         * Global Availability Feed
         * Shows when chapters become readable on any source, merged with system events.
         * Includes event weighting for optimal readability.
         */
        AVAILABILITY_FEED: `
          WITH all_events AS (
            -- 1. Chapter Availability Events (Weights 3 and 2)
            SELECT 
              cs.id as source_id,
              ss.source_name,
              cs.source_chapter_url as source_url,
              cs.detected_at as discovered_at,
              cs.chapter_id,
              lc.chapter_number,
              lc.chapter_title,
              s.id as series_id,
              s.title as series_title,
              s.cover_url,
              CASE 
                WHEN cs.discovered_at = (
                  SELECT MIN(discovered_at) 
                  FROM chapter_sources 
                  WHERE chapter_id = cs.chapter_id
                ) THEN 3 -- New chapter availability (HIGH)
                ELSE 2   -- Additional source (MEDIUM)
              END as event_weight,
              COUNT(*) OVER (PARTITION BY lc.id) as chapter_source_count,
              EXISTS(
                SELECT 1 FROM user_chapter_reads_v2 ucr 
                WHERE ucr.chapter_id = lc.id AND ucr.user_id = $2::uuid
              ) as is_read
            FROM chapter_sources cs
            JOIN series_sources ss ON cs.series_source_id = ss.id
            JOIN logical_chapters lc ON cs.chapter_id = lc.id
            JOIN series s ON lc.series_id::uuid = s.id::uuid
            WHERE lc.deleted_at IS NULL AND s.deleted_at IS NULL
            
            UNION ALL
            
            -- 2. Metadata and System Events (Weights 1 and 0)
            SELECT 
              a.id as source_id,
              'system' as source_name,
              NULL as source_url,
              a.created_at as discovered_at,
              a.logical_chapter_id as chapter_id,
              lc.chapter_number,
              lc.chapter_title,
              s.id as series_id,
              s.title as series_title,
              s.cover_url,
              CASE 
                WHEN a.type = 'metadata_updated' THEN 1 -- Metadata updates (LOW)
                WHEN a.type IN ('resync', 'retry') THEN 0 -- Re-sync (LOWEST)
                ELSE 0
              END as event_weight,
              0 as chapter_source_count,
              FALSE as is_read
            FROM activities a
            LEFT JOIN series s ON a.series_id::uuid = s.id::uuid
            LEFT JOIN logical_chapters lc ON a.logical_chapter_id::uuid = lc.id::uuid
            WHERE a.type IN ('metadata_updated', 'resync', 'retry')
            )
              SELECT * FROM all_events
              ORDER BY discovered_at::date DESC, event_weight DESC, discovered_at DESC
              LIMIT $1::integer;
          `
        };
