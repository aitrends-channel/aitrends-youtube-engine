-- Ten more sounds.
--
-- 158 shipped eleven. These fill the gaps people reach for: a reverse whoosh
-- for the beat before a cut, a tick and a beep for small machine moments, a
-- ding and a sparkle for something landing well, a boom and a heartbeat for
-- weight, a glitch, a camera shutter and a page turn.
--
-- All synthesised by the worker's scripts/make-sfx.sh like the first eleven,
-- so the set stays licence-free and reproducible. Widens the constraint rather
-- than editing 158, which may already have run.

ALTER TABLE project_beats
  DROP CONSTRAINT IF EXISTS project_beats_sound_effect_check;

ALTER TABLE project_beats
  ADD CONSTRAINT project_beats_sound_effect_check
  CHECK (sound_effect IS NULL OR sound_effect IN (
    'whoosh', 'reverse-whoosh', 'swish', 'sweep', 'page',
    'click', 'tick', 'pop', 'beep', 'glitch', 'shutter',
    'zoom-in', 'zoom-out', 'riser',
    'impact', 'boom', 'thud', 'heartbeat',
    'chime', 'ding', 'sparkle'
  ));
