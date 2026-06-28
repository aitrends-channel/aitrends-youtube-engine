-- Lets the user short-circuit the final-burn pass and accept the
-- in-progress preview as the final video.
--
-- On long projects (>80 beats) the worker uploads mixed.mp4 to R2
-- the moment voiceover + bgm + visuals are combined, then spends
-- another 5-25 min on the captions/logo/upscale burn pass. The
-- preview lets the user watch the result early; this flag lets
-- them say "good enough, ship what we have, skip the burn."
--
-- Worker polls this alongside assembly_stop_requested every 3s.
-- When set, the worker aborts the burn pass, promotes
-- assembly_preview_url → assembled_url, and transitions to "done".
-- Cleared by the worker on every terminal transition so a stale
-- value doesn't auto-trigger on the next run.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS assembly_finalize_preview_requested boolean NOT NULL DEFAULT false;
