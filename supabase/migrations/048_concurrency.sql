-- Admin-tunable concurrency knobs for every process that does
-- concurrent work — the video worker, the per-step workflow chunks,
-- the cron poller, the image/thumbnail/TTS generation batches, and
-- the assembly worker (project- and beat-level).
--
-- The column has been renamed twice during iteration:
--   concurrency_config → badged_processes → batched_processes
-- The DO-block below carries data forward from whichever earlier name
-- exists, so this migration is idempotent regardless of which prior
-- version of itself was applied.
--
-- Defaults mirror the constants the code shipped with:
--   video_worker             3
--   image_prompts_chunks     1
--   video_prompts_chunks     1
--   finish_images_poll       5
--   image_generation_batch   3
--   thumbnail_batch          2
--   tts_beat_batch           5
--   assembly_projects        1
--   assembly_beats           1

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS batched_processes JSONB;

-- Forward-port from any earlier column name this knob has had.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'product_config'
       AND column_name = 'badged_processes'
  ) THEN
    EXECUTE $sql$
      UPDATE product_config
         SET batched_processes = badged_processes
       WHERE service = '_global'
         AND batched_processes IS NULL
         AND badged_processes IS NOT NULL
    $sql$;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'product_config'
       AND column_name = 'concurrency_config'
  ) THEN
    EXECUTE $sql$
      UPDATE product_config
         SET batched_processes = concurrency_config
       WHERE service = '_global'
         AND batched_processes IS NULL
         AND concurrency_config IS NOT NULL
    $sql$;
  END IF;
END $$;

-- Seed defaults if still empty.
UPDATE product_config
   SET batched_processes = jsonb_build_object(
         'video_worker',           3,
         'image_prompts_chunks',   1,
         'video_prompts_chunks',   1,
         'finish_images_poll',     5,
         'image_generation_batch', 3,
         'thumbnail_batch',        2,
         'tts_beat_batch',         5,
         'assembly_projects',      1,
         'assembly_beats',         1
       )
 WHERE service = '_global'
   AND batched_processes IS NULL;

-- Backfill the assembly keys onto rows that were seeded before these
-- knobs existed. jsonb || rhs lets the existing fields stay; we only
-- set keys that are missing.
UPDATE product_config
   SET batched_processes = batched_processes || jsonb_build_object(
         'assembly_projects', COALESCE((batched_processes ->> 'assembly_projects')::int, 1),
         'assembly_beats',    COALESCE((batched_processes ->> 'assembly_beats')::int,    1)
       )
 WHERE service = '_global'
   AND batched_processes IS NOT NULL
   AND (
        NOT (batched_processes ? 'assembly_projects')
     OR NOT (batched_processes ? 'assembly_beats')
   );

-- Drop the prior column names. Safe to run because their data was
-- carried forward into batched_processes by the DO-block above.
ALTER TABLE product_config DROP COLUMN IF EXISTS badged_processes;
ALTER TABLE product_config DROP COLUMN IF EXISTS concurrency_config;
