-- Persist the assemble page's per-project settings on the project row
-- so a refresh, return-visit, or Resume after Stop hydrates the user's
-- last choices instead of resetting to the page defaults.
--
-- Previously only BGM (047) and logo (also 047) survived a refresh.
-- Trim-silence and the five caption options were React-only state, so
-- a user who configured captions to "bold / large / top" and clicked
-- Assemble had to re-pick them on every subsequent session — annoying,
-- and worse during a Resume where the wrong style flipped the
-- captions_hash and invalidated the entire visuals checkpoint.
--
-- trim_silence_enabled  → matches the assemble page's `trimSilence`
--                         toggle and the worker's trimSilenceEnabled
--                         flag. Default TRUE because the page already
--                         defaults to "trimmed" preview.
-- captions_enabled      → caption burn-in master switch.
-- captions_language     → "source" or an ISO-ish lang code.
-- captions_style        → classic / bold / boxed / minimal.
-- captions_size         → small / medium / large.
-- captions_position     → top / bottom.
--
-- All nullable for backwards compat with projects that pre-date this
-- migration; the assemble page falls back to its existing React-side
-- defaults when a column is NULL.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS trim_silence_enabled BOOLEAN,
  ADD COLUMN IF NOT EXISTS captions_enabled     BOOLEAN,
  ADD COLUMN IF NOT EXISTS captions_language    TEXT,
  ADD COLUMN IF NOT EXISTS captions_style       TEXT,
  ADD COLUMN IF NOT EXISTS captions_size        TEXT,
  ADD COLUMN IF NOT EXISTS captions_position    TEXT;
