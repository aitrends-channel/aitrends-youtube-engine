-- Let image movement alternate per beat.
--
-- 'auto' gives consecutive still beats opposite directions rather than the same
-- push a hundred times over, which is what makes a slideshow read as edited
-- instead of processed. The direction is derived from the beat number at encode
-- time, so it is stable across a resumed assembly.
--
-- Migration 146 shipped the column with a three-value constraint. This widens
-- it rather than editing that file, since 146 may already have run.

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_image_motion_check;

ALTER TABLE projects
  ADD CONSTRAINT projects_image_motion_check
  CHECK (image_motion IN ('none', 'zoom-in', 'zoom-out', 'auto'));
