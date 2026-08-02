-- Length of the finished video, in milliseconds.
--
-- The worker already computes this (totalDuration, the voiceover-aligned
-- timeline it encodes against) but never persisted it, so the admin videos
-- table had no way to show how long a video actually is. Written alongside
-- assembled_url on both completion paths.
--
-- Nullable with no default: NULL means "assembled before this column
-- existed, or promoted from a preview", and the admin column renders a dash
-- rather than a misleading 0:00.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS assembled_duration_ms INTEGER;

COMMENT ON COLUMN projects.assembled_duration_ms IS
  'Duration of assembled_url in milliseconds, stamped by the video worker at assembly completion. NULL for videos assembled before 2026-08.';
