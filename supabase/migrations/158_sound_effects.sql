-- A sound on a beat, and how loud the set of them sits.
--
-- The library ships with the worker and is synthesised rather than sourced:
-- scripts/make-sfx.sh builds every file from noise and tones, so there is no
-- licence to honour and no file whose origin nobody can account for. The ids
-- below are those filenames.
--
-- Per beat rather than per transition. An accent lands on a shot — the click
-- on the moment a number appears, the chime on the point being made — and the
-- beat is the thing that has a moment.
--
-- The level is project-wide because it is one decision: nobody sets a
-- different effects volume for beat 14.

ALTER TABLE project_beats
  ADD COLUMN IF NOT EXISTS sound_effect TEXT;

ALTER TABLE project_beats
  DROP CONSTRAINT IF EXISTS project_beats_sound_effect_check;

ALTER TABLE project_beats
  ADD CONSTRAINT project_beats_sound_effect_check
  CHECK (sound_effect IS NULL OR sound_effect IN (
    'whoosh', 'swish', 'sweep', 'click', 'pop',
    'zoom-in', 'zoom-out', 'riser', 'impact', 'thud', 'chime'
  ));

COMMENT ON COLUMN project_beats.sound_effect IS
  'Sound played at this beat''s start during assembly. NULL is silence. Ids match assets/sfx in the worker.';

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS sfx_volume NUMERIC NOT NULL DEFAULT 0.6;

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_sfx_volume_check;

ALTER TABLE projects
  ADD CONSTRAINT projects_sfx_volume_check
  CHECK (sfx_volume >= 0 AND sfx_volume <= 1);
