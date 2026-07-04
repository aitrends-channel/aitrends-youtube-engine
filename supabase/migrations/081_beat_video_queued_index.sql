-- The video-worker's pollLoop runs every 5s, 24/7, looking for beats to
-- claim:
--
--   SELECT beat_number, project_id, video_prompt, image_url, projects!inner(...)
--   FROM project_beats
--   WHERE video_status = 'queued'
--   LIMIT <slots>;
--
-- project_beats.video_status has no index, so every tick was a seq scan
-- across the entire beats table — ~17k queries/day that grow linearly
-- with the table. This was almost certainly the top item in the
-- Supabase disk-IO advisor.
--
-- Partial index by design: 'queued' rows are a tiny fraction of the
-- table (all completed / failed / rendering beats are ignored), which
-- keeps the index small and keeps writes cheap — only INSERTs and the
-- transient submitting→rendering→done transitions touch it. Mirrors
-- the shape of project_beats_inflight_image_idx (migration 035) and
-- project_beats_video_started_at_idx (migration 079).
--
-- Plain CREATE INDEX (not CONCURRENTLY) because Supabase's migration
-- runner wraps every migration in a transaction and CONCURRENTLY can't
-- run inside one. The partial predicate keeps this index tiny, so the
-- ACCESS EXCLUSIVE lock during build is measured in milliseconds — the
-- worker's next poll tick catches up without missing beats.

CREATE INDEX IF NOT EXISTS project_beats_video_queued_idx
  ON project_beats (project_id)
  WHERE video_status = 'queued';
