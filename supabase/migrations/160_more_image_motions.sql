-- More camera moves.
--
-- 150 settled on six. These add the other two directions (up and down), the
-- mirror of the drift, a push into a corner, and three that come back where
-- they started: a sway, a float, and a handheld shake for a shot that should
-- feel alive without going anywhere.
--
-- Auto now cycles six directions rather than four. Random draws from the nine
-- that travel; sway, float and handheld stay out of both, being a decision
-- about a particular shot rather than something to scatter across a hundred.
--
-- Widens both constraints rather than editing 150 or 152, either of which may
-- already have run.

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_image_motion_check;

ALTER TABLE projects
  ADD CONSTRAINT projects_image_motion_check
  CHECK (image_motion IN (
    'none', 'zoom-in', 'zoom-out',
    'pan-right', 'pan-left', 'pan-up', 'pan-down',
    'drift', 'drift-left', 'diagonal',
    'sway', 'float', 'handheld',
    'auto', 'random'
  ));

ALTER TABLE project_beats
  DROP CONSTRAINT IF EXISTS project_beats_image_motion_check;

ALTER TABLE project_beats
  ADD CONSTRAINT project_beats_image_motion_check
  CHECK (image_motion IS NULL OR image_motion IN (
    'none', 'zoom-in', 'zoom-out',
    'pan-right', 'pan-left', 'pan-up', 'pan-down',
    'drift', 'drift-left', 'diagonal',
    'sway', 'float', 'handheld',
    'auto', 'random'
  ));
