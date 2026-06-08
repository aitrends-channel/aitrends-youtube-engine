-- Track WHICH step (images / videos) currently owns the active
-- prompts_active_run_id. Without it, the prompts page can't tell on
-- refresh whether a running route is generating image prompts or
-- video prompts — and falsely showed image as "Generating…" while a
-- video run was in flight (when image beats were partial from a
-- prior stopped image run).
ALTER TABLE projects ADD COLUMN IF NOT EXISTS prompts_active_step TEXT;
