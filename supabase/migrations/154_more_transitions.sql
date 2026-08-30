-- More ways for one beat to give way to the next.
--
-- 153 shipped four. ffmpeg offers fifty-odd; these are the ones that read as a
-- deliberate edit at the length a narrated beat runs, rather than as a glitch:
-- the fades, two slides and three wipes, a soft wipe, the circles, and four
-- that alter the picture on the way through.
--
-- Widens the constraint rather than editing 153, which may already have run.

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_transition_check;

ALTER TABLE projects
  ADD CONSTRAINT projects_transition_check
  CHECK (transition IN (
    'none',
    'dissolve', 'fade-black', 'fade-white', 'fade-grays',
    'slide-left', 'slide-up',
    'wipe-right', 'wipe-up', 'wipe-diagonal',
    'smooth-right',
    'circle-open', 'circle-close',
    'zoom', 'pixelize', 'blur', 'grain'
  ));
