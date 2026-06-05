-- Persist the in-flight KIE image task id on the beat row so the UI can
-- resume polling after a page refresh, timeout, or tab close. Without
-- this column the taskId lives only in client memory: any disconnect
-- loses the link between a generated KIE image and the beat that owns
-- it, even though KIE keeps the result. image_model_id is stored
-- alongside because the poll route's endpoint shape differs by model.

ALTER TABLE project_beats ADD COLUMN IF NOT EXISTS image_task_id TEXT;
ALTER TABLE project_beats ADD COLUMN IF NOT EXISTS image_model_id TEXT;

-- Partial index for the recovery query: "find beats this user has
-- in-flight image tasks for." Small, hot path on page load.
CREATE INDEX IF NOT EXISTS project_beats_inflight_image_idx
  ON project_beats (project_id)
  WHERE image_task_id IS NOT NULL AND image_url IS NULL;
