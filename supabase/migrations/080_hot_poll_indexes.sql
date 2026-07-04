-- The SWR poll behind useProject fires GET /api/projects/[id] every few
-- seconds while any workflow page is open. That endpoint runs one query
-- per hot child table:
--
--   SELECT * FROM project_beats     WHERE project_id = $1 ORDER BY beat_number;
--   SELECT * FROM project_thumbnails WHERE project_id = $1 ORDER BY position;
--
-- Postgres does not auto-create indexes for foreign keys, so both of these
-- were seq-scanning the entire table on every tick. The Supabase Disk-IO
-- budget warning that prompted this migration was almost certainly driven
-- by that pattern (poll frequency × user count × table size).
--
-- We already have a partial index on project_beats (migration 035) for the
-- KIE recovery query — it is not usable here because the poll does not
-- carry the `image_task_id IS NOT NULL AND image_url IS NULL` predicate.
--
-- CONCURRENTLY keeps writes flowing during the build (no ACCESS EXCLUSIVE
-- lock). Must run outside a transaction; Supabase's migration runner
-- handles that automatically per statement.

CREATE INDEX CONCURRENTLY IF NOT EXISTS project_beats_project_id_idx
  ON project_beats (project_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS project_thumbnails_project_id_idx
  ON project_thumbnails (project_id);
