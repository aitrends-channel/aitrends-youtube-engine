-- Per-project video resolution / mode / quality preset.
--
-- Some KIE video models expose a resolution knob (e.g. seedance-2:
-- 480p/720p/1080p/4k, veo3: 720p/1080p/4k). Kling 3.0 uses "mode"
-- (std/pro/4K) and Runway uses "quality" (720p/1080p), but the
-- picker treats them uniformly and stores the chosen value in this
-- single column — the worker maps it to the correct KIE field name
-- at submit time via MODEL_RESOLUTION_KEYS.
--
-- NULL means the model doesn't accept a resolution parameter, or the
-- user is on a legacy project that predates this migration. Both
-- cases fall back to KIE's model default.

ALTER TABLE projects ADD COLUMN IF NOT EXISTS video_resolution TEXT;
