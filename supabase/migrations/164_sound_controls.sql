-- Level and pitch for one beat's sound.
--
-- The project-wide sfx_volume stays the master: these are relative to it, so
-- turning the whole bed down still turns everything down. A sound with no
-- values of its own plays as it always did.
--
-- Pitch is a playback-rate shift with the speed put back afterwards, so a
-- higher-pitched click is still a click rather than a shorter one. Bounded at
-- half and double, which is the range ffmpeg's atempo can compensate in one
-- pass and well past the point where a sound stops sounding like itself.

ALTER TABLE project_beats
  ADD COLUMN IF NOT EXISTS sound_volume NUMERIC;

ALTER TABLE project_beats
  DROP CONSTRAINT IF EXISTS project_beats_sound_volume_check;

ALTER TABLE project_beats
  ADD CONSTRAINT project_beats_sound_volume_check
  CHECK (sound_volume IS NULL OR (sound_volume >= 0 AND sound_volume <= 2));

ALTER TABLE project_beats
  ADD COLUMN IF NOT EXISTS sound_pitch NUMERIC;

ALTER TABLE project_beats
  DROP CONSTRAINT IF EXISTS project_beats_sound_pitch_check;

ALTER TABLE project_beats
  ADD CONSTRAINT project_beats_sound_pitch_check
  CHECK (sound_pitch IS NULL OR (sound_pitch >= 0.5 AND sound_pitch <= 2));

COMMENT ON COLUMN project_beats.sound_volume IS
  'Level for this beat''s sound, relative to projects.sfx_volume. NULL is 1.';
COMMENT ON COLUMN project_beats.sound_pitch IS
  'Pitch shift for this beat''s sound, 0.5 to 2. NULL is 1. Duration is preserved.';
