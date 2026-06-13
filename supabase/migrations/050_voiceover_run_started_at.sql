-- Stamp on the projects row so the UI can detect a stuck voiceover run.
--
-- Why: the TTS beats route claims voiceover_active_run_id at the top
-- of the function and clears it in a `finally` block. When Vercel
-- hits the 800-second function timeout, the finally never runs — the
-- worker is killed mid-execution and the run_id stays set in the DB.
-- The voiceover page hides the Generate button while
-- voiceover_active_run_id is non-null (so a refresh mid-run doesn't
-- look like the user has to click again to resume), which traps the
-- user in a "generating" state with nothing actually generating.
--
-- voiceover_run_started_at  → stamped at claim time, cleared at
--   release time. The page treats a run older than ~15 minutes
--   (comfortably past Vercel's 800s limit) as stale and unhides the
--   Generate button. Clicking Generate then overwrites the
--   phantom run_id with a fresh one and the route's existing
--   stale-beat reset (project_beats voiceover_status in
--   ("queued","generating") → NULL) cleans up the per-beat state.
--
-- No default; pre-existing rows have NULL — for projects with an
-- already-stuck voiceover_active_run_id, the page treats NULL
-- started_at as "infinitely old" so users can recover from the
-- exact bug this migration is fixing without manual DB cleanup.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS voiceover_run_started_at TIMESTAMPTZ;
