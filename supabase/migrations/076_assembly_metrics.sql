-- Per-stage memory + timing metrics for assembly runs.
--
-- Written by the video-worker at each stage boundary in runAssembly,
-- so we can tell after the fact where memory peaked and how long
-- each stage took. Stored as a single jsonb blob keyed by stage name
-- so the schema doesn't have to evolve every time a stage is added
-- or renamed.
--
-- Shape:
--   {
--     "peak_rss_mb": 612,
--     "stages": [
--       { "stage": "audio-prep", "rss_mb": 240, "heap_mb": 95, "t_ms": 4120 },
--       { "stage": "stage-b-encode", "rss_mb": 612, "heap_mb": 110, "t_ms": 28840 },
--       ...
--     ]
--   }
--
-- Cleared together with assembly_checkpoint on the success path; left
-- intact on failure for post-mortem.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS assembly_metrics jsonb;
