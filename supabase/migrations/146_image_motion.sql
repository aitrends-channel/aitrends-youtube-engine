-- Movement for beats that are a still image rather than a generated clip.
--
-- A customer who does not pay for video generation still gets a video: the
-- assembler loops each image for the length of its narration. What they get is
-- a sequence of motionless frames, which reads as a broken render rather than a
-- deliberate style. This is the setting that gives those frames a slow push in
-- or out.
--
-- Defaults to 'none' so no existing project changes behaviour on deploy, and so
-- a customer who has already assembled sees the same video if they assemble
-- again.
--
-- ORDER MATTERS: the worker's assembly-queue select names this column
-- explicitly, and a missing column fails that whole select, which would drop
-- every other assembly option back to its default (captions off, no logo). Run
-- this before deploying the worker that reads it.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS image_motion TEXT NOT NULL DEFAULT 'none';

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_image_motion_check;

ALTER TABLE projects
  ADD CONSTRAINT projects_image_motion_check
  CHECK (image_motion IN ('none', 'zoom-in', 'zoom-out'));

COMMENT ON COLUMN projects.image_motion IS
  'Movement applied to still-image beats during assembly: none, zoom-in or zoom-out. Clips generated as video are unaffected.';
