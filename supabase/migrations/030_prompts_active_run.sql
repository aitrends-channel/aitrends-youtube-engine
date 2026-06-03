-- Cancellation signal for in-flight prompts generation (image / video /
-- thumbnail prompt routes). Each /api/workflow/prompts invocation writes
-- a fresh UUID here at start and re-reads it between chunk writes. If
-- the value changes (a newer run claimed it) or goes NULL (a clear
-- happened), the in-flight route detects the mismatch and aborts so it
-- can't keep writing beats after the user wiped them.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS prompts_active_run_id UUID;
