-- An effect chosen for one beat, overriding the project's.
--
-- The project setting stays the default and this is the exception: nobody sets
-- two hundred beats by hand, but they will set the three that matter — a title
-- card that should hold still, a hero shot that should push in.
--
-- NULL means "use the project's setting", which is what every existing beat
-- does, so nothing already assembled changes.
--
-- Deliberately not cleared when a beat's image is regenerated. The choice is
-- about the shot, not the picture: someone who decided this beat holds still
-- means it whichever image ends up there.

ALTER TABLE project_beats
  ADD COLUMN IF NOT EXISTS image_motion TEXT;

ALTER TABLE project_beats
  DROP CONSTRAINT IF EXISTS project_beats_image_motion_check;

ALTER TABLE project_beats
  ADD CONSTRAINT project_beats_image_motion_check
  CHECK (image_motion IS NULL OR image_motion IN
    ('none', 'zoom-in', 'zoom-out', 'pan-right', 'pan-left', 'drift', 'auto', 'random'));

COMMENT ON COLUMN project_beats.image_motion IS
  'Per-beat override for the assembly image effect. NULL inherits projects.image_motion.';
