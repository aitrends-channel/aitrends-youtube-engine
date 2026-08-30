-- How much of the grade to apply.
--
-- A grade is a taste, and taste is a dial rather than a switch: the same warm
-- pass that suits one video is too much on the next. Every look in the worker
-- reaches identity at 0 and its full self at 1, including the ones built on
-- ffmpeg's curve presets, which carry their own points now so they can be
-- interpolated toward the straight line.
--
-- Defaults to 1, which is what every graded assembly did before this existed.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS video_filter_strength NUMERIC NOT NULL DEFAULT 1;

ALTER TABLE projects
  DROP CONSTRAINT IF EXISTS projects_video_filter_strength_check;

ALTER TABLE projects
  ADD CONSTRAINT projects_video_filter_strength_check
  CHECK (video_filter_strength >= 0 AND video_filter_strength <= 1);

COMMENT ON COLUMN projects.video_filter_strength IS
  'How much of video_filter to apply, 0 to 1. Ignored when video_filter is none.';
