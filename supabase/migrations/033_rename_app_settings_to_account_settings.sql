-- Rename app_settings → account_settings.
--
-- The original 005 migration created app_settings as a singleton config
-- row; 006 rebuilt it as per-user (PK on user_id). Today every column
-- on it is genuinely per-account state (API keys, niches_used,
-- niche_limit_override, demo_niche_created), so the "app_settings" name
-- is misleading.
--
-- ALTER TABLE RENAME is atomic, preserves rows / indexes / constraints
-- / RLS policies / FK cascade. The trigger reference auto-updates with
-- the table; we rename the trigger itself for tidiness. The three
-- plpgsql functions that read the table by literal name have to be
-- re-created against the new name — Postgres stores function bodies
-- as text and resolves table names at execute time.

ALTER TABLE app_settings RENAME TO account_settings;

ALTER TRIGGER app_settings_updated_at ON account_settings
  RENAME TO account_settings_updated_at;

-- Re-create the three niche-counter functions with the new table name.
-- Bodies are otherwise unchanged from migrations 014 and 015.

CREATE OR REPLACE FUNCTION try_use_niche(uid UUID, plan_limit INTEGER)
RETURNS TABLE (success BOOLEAN, niches_used INTEGER)
LANGUAGE plpgsql AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  INSERT INTO account_settings AS s (user_id, niches_used)
  VALUES (uid, 1)
  ON CONFLICT (user_id) DO UPDATE
    SET niches_used = s.niches_used + 1
    WHERE plan_limit IS NULL OR s.niches_used < plan_limit
  RETURNING s.niches_used INTO updated_count;

  IF updated_count IS NOT NULL THEN
    success := TRUE;
    niches_used := updated_count;
  ELSE
    SELECT s.niches_used INTO niches_used FROM account_settings s WHERE s.user_id = uid;
    success := FALSE;
  END IF;

  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION decrement_niches_used(uid UUID)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  new_count INTEGER;
BEGIN
  UPDATE account_settings
    SET niches_used = GREATEST(niches_used - 1, 0)
    WHERE user_id = uid
    RETURNING niches_used INTO new_count;
  RETURN COALESCE(new_count, 0);
END;
$$;

CREATE OR REPLACE FUNCTION reset_niches_used(uid UUID)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  new_count INTEGER;
BEGIN
  UPDATE account_settings SET niches_used = 0
    WHERE user_id = uid
    RETURNING niches_used INTO new_count;

  IF new_count IS NULL THEN
    INSERT INTO account_settings (user_id, niches_used) VALUES (uid, 0)
    ON CONFLICT (user_id) DO UPDATE SET niches_used = 0
    RETURNING niches_used INTO new_count;
  END IF;

  RETURN new_count;
END;
$$;
