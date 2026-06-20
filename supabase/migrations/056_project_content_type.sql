-- Content type the user selected at the channel step: 'long', 'shorts',
-- or 'both'. Drives which videos the YouTube fetch + downstream
-- analysis/script generation are scoped to. Nullable: existing rows
-- predate the choice (which the channel page treats as required for
-- new runs), so we leave them as NULL rather than backfilling a
-- potentially-wrong default — the script step already tolerates the
-- absence of this field.
--
-- Constrained to the three valid values so a typo / stale client can't
-- write a junk string the channel-step UI would then refuse to round-trip.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS content_type TEXT;

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_content_type_check;

ALTER TABLE projects
  ADD CONSTRAINT projects_content_type_check
  CHECK (content_type IS NULL OR content_type IN ('long', 'shorts', 'both'));
