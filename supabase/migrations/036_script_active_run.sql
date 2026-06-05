-- Active-run signal for script generation. Mirrors the existing
-- prompts_active_run_id (migration 030). The /api/workflow/script POST
-- handler writes a fresh UUID here at start and re-reads it between
-- streamed text deltas. If the value changes (newer run claimed it) or
-- is nulled out (final save / cancellation), the older run aborts so it
-- can't overwrite the new run's output.
--
-- Also enables the script page to detect "your previous run is still
-- generating in the background" on page refresh — the column is the
-- in-flight indicator, since project.script may still be empty for a
-- run that hasn't reached its final save yet.
--
-- Works regardless of whether the upstream provider streams in real
-- time (direct Anthropic) or batches (KIE proxy) — the flag is set at
-- function entry and cleared at the final DB write either way.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS script_active_run_id UUID;
