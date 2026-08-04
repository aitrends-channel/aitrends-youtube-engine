-- 1Click end-to-end timing. auto_pilot_started_at is stamped when the run
-- is engaged; auto_pilot_completed_at when the last thumbnail lands (state
-- 16). The final-video preview shows how long the whole run took.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_pilot_started_at   TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_pilot_completed_at TIMESTAMPTZ;
