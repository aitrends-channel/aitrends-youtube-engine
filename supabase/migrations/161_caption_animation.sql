-- How captions arrive on screen.
--
-- Until now they cut in and out with the words. These add a fade, a small pop,
-- and two that work at the level of individual words rather than lines:
-- karaoke, where the line is on screen and each word brightens as it is
-- spoken, and reveal, where the line builds a word at a time.
--
-- Those last two need the transcript's word timings, which the assembly
-- already has from Scribe. A translated caption no longer lines up with them,
-- so the worker falls back to the fade rather than drifting a word at a time.
--
-- Defaults to none, so nothing already assembled changes.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS captions_animation TEXT NOT NULL DEFAULT 'none';

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_captions_animation_check;

ALTER TABLE projects
  ADD CONSTRAINT projects_captions_animation_check
  CHECK (captions_animation IN ('none', 'fade', 'pop', 'karaoke', 'reveal'));

COMMENT ON COLUMN projects.captions_animation IS
  'How each caption arrives: none, fade, pop, karaoke (word brightens as spoken) or reveal (line builds word by word).';
