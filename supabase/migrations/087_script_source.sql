-- Distinguish manually written scripts from AI-generated ones.
--
-- The script step now offers "Write manually" next to "Generate with
-- AI". The paused-draft UI (Resume / Cancel) is keyed off
-- `script IS NOT NULL AND current_state < 7 AND no active run`, which
-- is exactly what a manual draft in progress looks like — without
-- this marker a reload would show the manual writer an AI "Resume"
-- button that continues their own words with the model.
--
-- Values: 'generated' | 'manual'. NULL means pre-feature rows, which
-- are all generated — the client treats NULL as 'generated'.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS script_source TEXT;
