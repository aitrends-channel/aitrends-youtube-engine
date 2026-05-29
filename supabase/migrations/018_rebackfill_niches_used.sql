-- Re-run the niches_used backfill defensively. The original 014 backfill
-- could have run before some users' projects existed or before their
-- channel_name was populated. This idempotent re-backfill brings everyone
-- up to date with their current unique-channel count, but only if the
-- stored counter is BELOW the actual count (we never decrement a
-- lifetime counter).

-- Update existing app_settings rows that are below the actual count.
UPDATE app_settings AS a
SET niches_used = sub.actual_count
FROM (
  SELECT
    user_id,
    COUNT(DISTINCT channel_name) FILTER (WHERE channel_name IS NOT NULL)
    + CASE WHEN COUNT(*) FILTER (WHERE channel_name IS NULL) > 0 THEN 1 ELSE 0 END AS actual_count
  FROM projects
  WHERE user_id IS NOT NULL
  GROUP BY user_id
) AS sub
WHERE a.user_id = sub.user_id
  AND a.niches_used < sub.actual_count;

-- Insert for users with projects but no app_settings row yet.
INSERT INTO app_settings (user_id, niches_used)
SELECT
  user_id,
  COUNT(DISTINCT channel_name) FILTER (WHERE channel_name IS NOT NULL)
  + CASE WHEN COUNT(*) FILTER (WHERE channel_name IS NULL) > 0 THEN 1 ELSE 0 END AS niches_used
FROM projects
WHERE user_id IS NOT NULL
GROUP BY user_id
ON CONFLICT (user_id) DO NOTHING;
