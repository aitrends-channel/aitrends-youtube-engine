-- Lifetime niche usage counter per user.
-- Prevents users from exploiting deletion to exceed their plan's niche limit.
-- The counter only increments on niche creation; deletions never decrement it.

ALTER TABLE app_settings ADD COLUMN IF NOT EXISTS niches_used INTEGER NOT NULL DEFAULT 0;

-- Backfill existing users so they aren't punished or rewarded by the switch.
-- Each existing project's unique channel_name (plus a +1 if any null-channel
-- in-progress project exists) counts as a lifetime niche used.
INSERT INTO app_settings (user_id, niches_used)
SELECT
  user_id,
  COUNT(DISTINCT channel_name) FILTER (WHERE channel_name IS NOT NULL)
  + CASE WHEN COUNT(*) FILTER (WHERE channel_name IS NULL) > 0 THEN 1 ELSE 0 END AS niches_used
FROM projects
WHERE user_id IS NOT NULL
GROUP BY user_id
ON CONFLICT (user_id) DO UPDATE
  SET niches_used = GREATEST(app_settings.niches_used, EXCLUDED.niches_used);

-- Atomically try to "use" a niche slot. Pass plan_limit = NULL to mean unlimited.
-- Returns the new niches_used count and whether the slot was granted.
CREATE OR REPLACE FUNCTION try_use_niche(uid UUID, plan_limit INTEGER)
RETURNS TABLE (success BOOLEAN, niches_used INTEGER)
LANGUAGE plpgsql AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  -- Insert new row (count 1) OR increment existing row, but only if still
  -- under the limit. The WHERE on the ON CONFLICT UPDATE is the key bit.
  INSERT INTO app_settings AS s (user_id, niches_used)
  VALUES (uid, 1)
  ON CONFLICT (user_id) DO UPDATE
    SET niches_used = s.niches_used + 1
    WHERE plan_limit IS NULL OR s.niches_used < plan_limit
  RETURNING s.niches_used INTO updated_count;

  IF updated_count IS NOT NULL THEN
    success := TRUE;
    niches_used := updated_count;
  ELSE
    -- Update was rejected (at or over limit). Read the current value.
    SELECT s.niches_used INTO niches_used FROM app_settings s WHERE s.user_id = uid;
    success := FALSE;
  END IF;

  RETURN NEXT;
END;
$$;

-- Rollback helper: if project insert fails after we already incremented,
-- decrement back. Never goes below zero.
CREATE OR REPLACE FUNCTION decrement_niches_used(uid UUID)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  new_count INTEGER;
BEGIN
  UPDATE app_settings
    SET niches_used = GREATEST(niches_used - 1, 0)
    WHERE user_id = uid
    RETURNING niches_used INTO new_count;
  RETURN COALESCE(new_count, 0);
END;
$$;
