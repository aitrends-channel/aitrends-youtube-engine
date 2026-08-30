-- An element drawn over one beat: an arrow, a circle, a badge, a bubble.
--
-- The set ships with the worker and is drawn rather than sourced: every file
-- under assets/elements comes out of scripts/make-elements.sh, where each
-- shape is an alpha mask written as maths. No licence, no attribution, and the
-- set rebuilds from the script.
--
-- Position and size are fractions of the frame, like the channel logo, so they
-- mean the same thing at every resolution. NULL on all four is no element,
-- which is what every existing beat has.
--
-- The element sits under the logo and beneath the captions: it decorates the
-- picture, the logo is channel furniture, and the words go on top of both.

ALTER TABLE project_beats
  ADD COLUMN IF NOT EXISTS element TEXT;

ALTER TABLE project_beats
  DROP CONSTRAINT IF EXISTS project_beats_element_check;

ALTER TABLE project_beats
  ADD CONSTRAINT project_beats_element_check
  CHECK (element IS NULL OR element IN (
    'subscribe', 'subscribed', 'like', 'share', 'follow', 'comment', 'new', 'live'
  ));

ALTER TABLE project_beats ADD COLUMN IF NOT EXISTS element_x NUMERIC;
ALTER TABLE project_beats ADD COLUMN IF NOT EXISTS element_y NUMERIC;
ALTER TABLE project_beats ADD COLUMN IF NOT EXISTS element_size NUMERIC;

ALTER TABLE project_beats DROP CONSTRAINT IF EXISTS project_beats_element_pos_check;
ALTER TABLE project_beats
  ADD CONSTRAINT project_beats_element_pos_check
  CHECK (
    (element_x IS NULL OR (element_x >= 0 AND element_x <= 1))
    AND (element_y IS NULL OR (element_y >= 0 AND element_y <= 1))
    AND (element_size IS NULL OR (element_size > 0 AND element_size <= 0.8))
  );

COMMENT ON COLUMN project_beats.element IS
  'Shape drawn over this beat during assembly. NULL is none. Ids match assets/elements in the worker.';
