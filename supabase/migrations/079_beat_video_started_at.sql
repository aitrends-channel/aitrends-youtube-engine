-- Stamp added on every atomic transition of project_beats.video_status
-- into "submitting" (by tryClaimBeat) and again when it flips to
-- "rendering" (by processBeat's promotion). The video-worker's stuck-
-- beat sweeper uses this to identify orphaned beats — a beat that has
-- been in a non-terminal state for longer than the KIE poll budget
-- (~30 minutes) is definitely no longer being processed and should be
-- returned to "queued" for retry.
--
-- Nullable because pre-existing beats predate this column; the sweeper
-- treats NULL as "old enough to reset" (safe default).

ALTER TABLE project_beats
  ADD COLUMN IF NOT EXISTS video_started_at TIMESTAMPTZ;

-- Cheap partial index — the sweeper only ever reads rows in the two
-- transient states, and those two are always a tiny fraction of the
-- beats table.
CREATE INDEX IF NOT EXISTS project_beats_video_started_at_idx
  ON project_beats (video_started_at)
  WHERE video_status IN ('submitting', 'rendering');
