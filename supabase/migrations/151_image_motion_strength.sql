-- How far image movement travels.
--
-- The move always takes exactly the length of its beat, so distance is the only
-- thing that can vary, and distance is what reads as speed: further in the same
-- seconds is faster. gentle 8%, normal 15%, strong 25% of the frame.
--
-- Capped at a quarter deliberately. The source is scaled to the move's furthest
-- extent before it runs, so a stronger setting samples further into an image
-- that may not have the pixels; past about a quarter, provider images soften
-- visibly.
--
-- Defaults to 'normal', which is what every project rendered with before this
-- was a choice, so nothing already assembled changes.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS image_motion_strength TEXT NOT NULL DEFAULT 'normal';

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_image_motion_strength_check;

ALTER TABLE projects
  ADD CONSTRAINT projects_image_motion_strength_check
  CHECK (image_motion_strength IN ('gentle', 'normal', 'strong'));

-- And how long each move takes, in seconds.
--
-- Distance and duration together are what "speed" means here: the same travel
-- over a shorter time is a faster move. NULL or 0 means the move spans the
-- whole beat, which is what every render did before this existed. Clamped to
-- the beat length at encode time, since a move that cannot finish reads as an
-- arbitrary crop rather than a move.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS image_motion_seconds NUMERIC;

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_image_motion_seconds_check;

ALTER TABLE projects
  ADD CONSTRAINT projects_image_motion_seconds_check
  CHECK (image_motion_seconds IS NULL OR (image_motion_seconds >= 0 AND image_motion_seconds <= 20));
