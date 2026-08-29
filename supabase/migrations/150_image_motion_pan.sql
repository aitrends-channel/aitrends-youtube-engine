-- Pan and drift, alongside the zooms.
--
-- 'random' scatters all five across the beats, chosen by hashing the beat
-- number so the same video assembles identically every time. pan-right and
-- pan-left hold the zoom and slide the frame; drift does both,
-- which is what people mean by Ken Burns. 'auto' now cycles all four rather
-- than flipping between two, so consecutive stills differ in kind and not only
-- in direction.
--
-- Widens the constraint again rather than editing 146 or 149, either of which
-- may already have run.

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_image_motion_check;

ALTER TABLE projects
  ADD CONSTRAINT projects_image_motion_check
  CHECK (image_motion IN ('none', 'zoom-in', 'zoom-out', 'pan-right', 'pan-left', 'drift', 'auto', 'random'));
