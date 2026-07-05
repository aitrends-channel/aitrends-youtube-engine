-- Early preview URL for a still-in-progress assembly.
--
-- After the worker's mix step succeeds (voiceover + bgm + concatenated
-- visuals all combined), mixed.mp4 is a complete watchable video — it's
-- just missing the final-burn pass that bakes in captions/logo and
-- upscales to the user's chosen resolution. That burn pass runs another
-- 5-25 min on long projects, during which the user has nothing to look
-- at but the progress bar.
--
-- The worker writes the mixed.mp4 R2 URL here so the front-end can show
-- a "preview while you wait" video player. Cleared on the terminal
-- transition (done / failed / stopped) so a stale URL doesn't linger.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS assembly_preview_url text;
