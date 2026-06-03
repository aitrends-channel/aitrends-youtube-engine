-- Denormalise the account's email onto account_settings so admin SQL
-- and any future route that needs settings + email can avoid a round
-- trip through supabase.auth.admin.listUsers.
--
-- Two triggers keep it in sync:
--   1. auth.users → account_settings: on UPDATE of email, propagate
--      to the matching row.
--   2. account_settings INSERT: when a row is created without an
--      email value (the usual path — try_use_niche, the admin
--      niche-limit upsert, settings POST, etc. all omit it), fill
--      from auth.users in a BEFORE trigger so the inserted row already
--      carries the value.
--
-- Both functions use SECURITY DEFINER + an explicit search_path so they
-- can cross the auth → public boundary safely.

ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS email TEXT;

-- Backfill existing rows. New rows created after this point go through
-- the BEFORE INSERT trigger below.
UPDATE account_settings AS a
SET email = u.email
FROM auth.users AS u
WHERE a.user_id = u.id
  AND (a.email IS DISTINCT FROM u.email);

-- ── Sync from auth.users → account_settings ─────────────────────────
CREATE OR REPLACE FUNCTION sync_account_settings_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only act on actual email changes; saves write amplification.
  IF OLD.email IS DISTINCT FROM NEW.email THEN
    UPDATE public.account_settings
      SET email = NEW.email
      WHERE user_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS auth_users_sync_account_email ON auth.users;
CREATE TRIGGER auth_users_sync_account_email
  AFTER UPDATE OF email ON auth.users
  FOR EACH ROW EXECUTE FUNCTION sync_account_settings_email();

-- ── Lazy fill on account_settings INSERT ────────────────────────────
CREATE OR REPLACE FUNCTION account_settings_fill_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS NULL THEN
    SELECT email INTO NEW.email FROM auth.users WHERE id = NEW.user_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS account_settings_fill_email_trigger ON account_settings;
CREATE TRIGGER account_settings_fill_email_trigger
  BEFORE INSERT ON account_settings
  FOR EACH ROW EXECUTE FUNCTION account_settings_fill_email();
