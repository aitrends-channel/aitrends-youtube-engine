-- How one beat gives way to the next.
--
-- Every assembly so far has been hard cuts, which is the right default for a
-- narrated video: a cut is invisible and a dissolve is not. It is the wrong
-- only option, because a sequence of stills reads as a slideshow of unrelated
-- pictures without something joining them.
--
-- A transition costs time from both sides: an xfade of t seconds turns 2t
-- seconds of footage into t. The worker pays for that by encoding each beat
-- t seconds longer than its narration, so the overlap eats the extension and
-- the video stays the length of the voiceover. That is why the seconds live
-- here next to the kind: the two are one setting.
--
-- Defaults to none, so nothing already assembled changes.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS transition TEXT NOT NULL DEFAULT 'none';

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_transition_check;

ALTER TABLE projects
  ADD CONSTRAINT projects_transition_check
  CHECK (transition IN ('none', 'dissolve', 'fade-black', 'slide-left', 'wipe-right'));

COMMENT ON COLUMN projects.transition IS
  'Cross-fade applied at every beat boundary during assembly. none is a hard cut.';

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS transition_seconds NUMERIC;

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_transition_seconds_check;

ALTER TABLE projects
  ADD CONSTRAINT projects_transition_seconds_check
  CHECK (transition_seconds IS NULL OR (transition_seconds > 0 AND transition_seconds <= 2));

COMMENT ON COLUMN projects.transition_seconds IS
  'Length of each transition. NULL means the default (0.5s). Clamped at render to a fifth of the shortest beat.';
