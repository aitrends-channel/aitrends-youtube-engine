-- Five more ways a caption can arrive.
--
-- 161 shipped fade, pop, karaoke and reveal. These add a slide up into place,
-- a slow grow across the whole line, a tilt that straightens on arrival, a
-- flash that lands in yellow and settles, and a typewriter that reveals letter
-- by letter in time with the speech rather than at a fixed rate.
--
-- Typewriter joins karaoke and reveal in needing the transcript's word
-- timings, so it falls back to the fade on a translated caption.
--
-- Widens the constraint rather than editing 161, which may already have run.

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_captions_animation_check;

ALTER TABLE projects
  ADD CONSTRAINT projects_captions_animation_check
  CHECK (captions_animation IN (
    'none', 'fade', 'pop', 'slide', 'grow', 'tilt', 'flash',
    'karaoke', 'reveal', 'typewriter'
  ));
