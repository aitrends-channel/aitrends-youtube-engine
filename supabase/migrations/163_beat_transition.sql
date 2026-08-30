-- The transition at one cut, overriding the project's.
--
-- The column belongs to the beat BEFORE the cut: beat 3's value is what
-- happens between beat 3 and beat 4. The last beat's is ignored, there being
-- nothing after it.
--
-- NULL follows the project, which is what every existing beat does. The length
-- stays project-wide: a video whose seams ran at different speeds would read
-- as a fault rather than as a style.
--
-- This is what "randomize" writes: a real value per cut, stored, so the render
-- and the preview agree and a re-render produces the same video.

ALTER TABLE project_beats
  ADD COLUMN IF NOT EXISTS transition TEXT;

ALTER TABLE project_beats
  DROP CONSTRAINT IF EXISTS project_beats_transition_check;

ALTER TABLE project_beats
  ADD CONSTRAINT project_beats_transition_check
  CHECK (transition IS NULL OR transition IN (
    'none','dissolve','fade-black','fade-white','fade-grays','slide-left','slide-up',
    'wipe-right','wipe-up','wipe-diagonal','smooth-right','circle-open','circle-close',
    'zoom','pixelize','blur','grain'
  ));

COMMENT ON COLUMN project_beats.transition IS
  'Transition at the cut after this beat. NULL inherits projects.transition.';
