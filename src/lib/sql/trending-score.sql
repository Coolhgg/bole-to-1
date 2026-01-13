-- Trending Score Query
-- Uses internal engagement signals with time-decay
-- 
-- SCORING FORMULA:
-- score = (recent_chapter_events * 3) + (unique_readers * 2) + (follows_delta * 2) + total_reads
--
-- RULES:
-- - Tier A only (actively maintained catalog)
-- - Dead manga excluded (no chapters in 90+ days)
-- - Time-decayed (7/30 day windows)

-- For 7-day trending (weekly)
WITH activity_7d AS (
  SELECT 
    series_id,
    COUNT(*) FILTER (WHERE event_type = 'chapter_detected') AS chapter_events,
    COUNT(*) FILTER (WHERE event_type = 'user_read') AS read_events,
    COUNT(DISTINCT CASE WHEN event_type = 'user_read' THEN series_id END) AS unique_readers,
    COUNT(*) FILTER (WHERE event_type = 'user_follow') AS follow_events
  FROM series_activity_events
  WHERE created_at >= NOW() - INTERVAL '7 days'
  GROUP BY series_id
),
follows_delta_7d AS (
  SELECT 
    series_id,
    COUNT(*) AS new_follows
  FROM library_entries
  WHERE added_at >= NOW() - INTERVAL '7 days'
    AND deleted_at IS NULL
  GROUP BY series_id
)
SELECT 
  s.id,
  s.title,
  s.cover_url,
  s.type,
  s.status,
  s.genres,
  s.total_follows,
  s.average_rating,
  s.last_chapter_at,
  -- Trending Score Calculation
  (
    COALESCE(a.chapter_events, 0) * 3 +
    COALESCE(a.unique_readers, 0) * 2 +
    COALESCE(f.new_follows, 0) * 2 +
    COALESCE(a.read_events, 0)
  ) AS trending_score
FROM series s
LEFT JOIN activity_7d a ON a.series_id = s.id
LEFT JOIN follows_delta_7d f ON f.series_id = s.id
WHERE 
  s.catalog_tier = 'A'
  AND s.deleted_at IS NULL
  -- Exclude dead manga (no chapters in 90 days)
  AND s.last_chapter_at >= NOW() - INTERVAL '90 days'
ORDER BY trending_score DESC, s.total_follows DESC
LIMIT 50;

-- For 30-day trending (monthly) - same structure, different window
-- WITH activity_30d AS (
--   SELECT ... WHERE created_at >= NOW() - INTERVAL '30 days' ...
-- )
