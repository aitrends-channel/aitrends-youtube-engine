-- Per-account R2 storage totals, refreshed by /api/cron/storage-usage.
--
-- A cache rather than a live sum: usage is a per-prefix ListObjectsV2 walk and
-- heavy accounts hold 27k+ objects, far too slow on an upload. A whole-estate
-- sweep is ~200 Class B ops, so 6-hourly is free and that staleness is fine
-- for a cap measured in gigabytes.
--
-- Keyed on the R2 prefix (userFolderFor: lowercased email, else uuid).
-- user_id stays null when no account matches — deleted accounts still hold
-- objects, and those bytes belong in the admin storage view.
--
-- bonus_bytes lets support unblock one account without touching everyone's
-- plan allowance. Not a purchasable add-on.

CREATE TABLE IF NOT EXISTS storage_usage (
  prefix       TEXT        PRIMARY KEY,
  user_id      UUID,
  bytes        BIGINT      NOT NULL DEFAULT 0,
  object_count INTEGER     NOT NULL DEFAULT 0,
  bonus_bytes  BIGINT      NOT NULL DEFAULT 0,
  measured_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_storage_usage_user_id ON storage_usage (user_id);
CREATE INDEX IF NOT EXISTS idx_storage_usage_bytes   ON storage_usage (bytes DESC);

ALTER TABLE storage_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_own_storage_usage ON storage_usage;
CREATE POLICY users_own_storage_usage ON storage_usage
  FOR SELECT USING (auth.uid() = user_id);

COMMENT ON COLUMN storage_usage.bonus_bytes IS
  'Admin-granted extra storage, added to the plan allowance from free_quotas.storage_bytes. Not a purchasable add-on.';
