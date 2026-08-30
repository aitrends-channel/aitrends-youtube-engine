-- More grades.
--
-- 155 shipped nine. These add the looks people ask for by name: the teal and
-- orange split that reads as "film", a high-contrast noir, golden hour, bleach
-- bypass, cross process, a matte print, night, pastel, and a vignette — which
-- is not a grade at all, but is the same decision to the person making the
-- video and costs the same nothing per frame.
--
-- Widens the constraint rather than editing 155, which may already have run.

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_video_filter_check;

ALTER TABLE projects
  ADD CONSTRAINT projects_video_filter_check
  CHECK (video_filter IN (
    'none', 'warm', 'cool', 'vivid', 'muted', 'mono', 'sepia', 'vintage', 'faded', 'punch',
    'cinematic', 'noir', 'golden', 'bleach', 'cross', 'matte', 'night', 'pastel', 'vignette'
  ));
