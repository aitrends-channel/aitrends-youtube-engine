-- How much of a placed sound to play.
--
-- A sound cannot be stretched: the file is as long as it is, and slowing it
-- down is the pitch control, not a length control. What a person dragging the
-- end of a block actually wants is to hear less of it, so this is a trim.
--
-- NULL plays the whole file, which is what every existing row means and why
-- this is nullable rather than defaulted to the natural length: those lengths
-- live in the assets, and a default here would be a copy of them that goes
-- stale the next time a sound is regenerated.
--
-- Only the tail is trimmed. Trimming the head too would need a second column
-- and an offset in the mix, and the front of these sounds is the transient
-- that makes them read as a click or a hit at all.

ALTER TABLE project_sounds
  ADD COLUMN IF NOT EXISTS duration_sec NUMERIC;

ALTER TABLE project_sounds
  DROP CONSTRAINT IF EXISTS project_sounds_duration_check;

ALTER TABLE project_sounds
  ADD CONSTRAINT project_sounds_duration_check
  CHECK (duration_sec IS NULL OR (duration_sec > 0 AND duration_sec <= 30));

COMMENT ON COLUMN project_sounds.duration_sec IS
  'Seconds of the sound to play from its start. NULL plays the whole file.';
