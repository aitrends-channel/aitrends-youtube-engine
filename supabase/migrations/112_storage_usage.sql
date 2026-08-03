-- Per-account R2 storage totals, refreshed by /api/cron/storage-usage.
--
-- Why a cache rather than a live sum: usage is a per-prefix ListObjectsV2
-- walk, and heavy accounts already hold 27k+ objects — far too slow to run
-- on an upload. One bucket-wide sweep costs ~200 Class B ops for the whole
-- estate, so refreshing every 6 hours is effectively free and that much
-- staleness is fine for a cap measured in gigabytes.
--
-- Keyed on the R2 prefix, which is userFolderFor(user) — the lowercased
-- email, or the uuid when no email exists. user_id is resolved where we can
-- and left null otherwise (deleted accounts still hold objects, and their
-- bytes should stay visible to the admin storage view).
--
-- bonus_bytes is an admin grant, not a product. There is no paid storage
-- add-on: hitting the cap means deleting media or upgrading, which is how
-- the category handles it. The column exists so support can unblock a
-- specific account without editing everyone's plan allowance, and cap logic
-- adds it unconditionally because it is 0 for almost everybody.

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
