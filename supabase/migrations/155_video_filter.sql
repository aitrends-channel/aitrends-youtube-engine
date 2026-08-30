-- A colour grade over the whole video.
--
-- Named video_filter rather than filter: FILTER is a reserved word in Postgres
-- (the aggregate FILTER clause), and a column that needs quoting everywhere is
-- a trap for the next person writing a query by hand.
--
-- Applied to the picture only. Captions and the logo are drawn on top of a
-- graded frame rather than graded themselves, since neither is footage.
--
-- Defaults to none, so nothing already assembled changes.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS video_filter TEXT NOT NULL DEFAULT 'none';

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_video_filter_check;

ALTER TABLE projects
  ADD CONSTRAINT projects_video_filter_check
  CHECK (video_filter IN ('none', 'warm', 'cool', 'vivid', 'muted', 'mono', 'sepia', 'vintage', 'faded', 'punch'));

COMMENT ON COLUMN projects.video_filter IS
  'Colour grade applied to every beat during assembly. none leaves the footage alone.';
