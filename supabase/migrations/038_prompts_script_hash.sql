-- Tracks the script content the current beats/prompts/images/videos were
-- generated from. Lets the UI detect "downstream assets are stale because
-- the script was edited after generation" without diffing the full text,
-- and lets the prompts workflow's resume path know when to discard
-- prior beats instead of reusing them.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS prompts_script_hash TEXT;
