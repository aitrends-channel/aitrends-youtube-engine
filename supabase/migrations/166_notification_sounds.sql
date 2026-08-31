-- Three more sounds: a bell, and the two things a phone does.
--
-- 158 shipped eleven and 159 widened it to twenty-one. These fill the gap that
-- was left: nothing in the set was a notification, and the nearest thing to a
-- bell was 'ding', which is a single tone with a long tail rather than metal.
--
-- 'bell' rings on inharmonic partials the way a struck bell does, including
-- the minor third that makes it read as metal. 'notification' is the two-note
-- figure a phone plays. 'alert' is three flat beeps, for attention rather than
-- for delight.
--
-- All synthesised by the worker's scripts/make-sfx.sh like the rest, so the
-- set stays licence-free and reproducible. Widens the constraint rather than
-- editing 158 or 159, which may already have run.

ALTER TABLE project_beats
  DROP CONSTRAINT IF EXISTS project_beats_sound_effect_check;

ALTER TABLE project_beats
  ADD CONSTRAINT project_beats_sound_effect_check
  CHECK (sound_effect IS NULL OR sound_effect IN (
    'whoosh', 'reverse-whoosh', 'swish', 'sweep', 'page',
    'click', 'tick', 'pop', 'beep', 'glitch', 'shutter',
    'zoom-in', 'zoom-out', 'riser',
    'impact', 'boom', 'thud', 'heartbeat',
    'chime', 'ding', 'sparkle',
    'bell', 'notification', 'alert'
  ));
