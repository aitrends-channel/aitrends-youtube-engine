-- Admin-tunable concurrency knobs for every process that does
-- concurrent work — the video worker, the per-step workflow chunks,
-- the cron poller, and the image/thumbnail/TTS generation batches.
-- Stored as a single JSONB column on product_config._global so we
-- don't need an ALTER for every new knob.
--
-- The column was originally named concurrency_config; renamed to
-- badged_processes to match the admin tab "Badged processes". The
-- DO-block below handles both cases: never-applied (fresh ADD COLUMN)
-- and already-applied-with-old-name (rename + carry data forward).
--
-- Defaults mirror the constants the code shipped with:
--   video_worker             3
--   image_prompts_chunks     1
--   video_prompts_chunks     1
--   finish_images_poll       5
--   image_generation_batch   3
--   thumbnail_batch          2
--   tts_beat_batch           5

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS badged_processes JSONB;

-- Forward-port any data written under the old column name in earlier
-- iterations of this migration. Safe to run repeatedly: only fills
-- rows where badged_processes is still NULL.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'product_config'
       AND column_name = 'concurrency_config'
  ) THEN
    EXECUTE $sql$
      UPDATE product_config
         SET badged_processes = concurrency_config
       WHERE service = '_global'
         AND badged_processes IS NULL
         AND concurrency_config IS NOT NULL
    $sql$;
  END IF;
END $$;

-- Seed defaults if still empty.
UPDATE product_config
   SET badged_processes = jsonb_build_object(
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
   AND badged_processes IS NULL;

-- Backfill the assembly keys onto rows that were seeded before these
-- knobs existed. jsonb || rhs lets the existing fields stay; we only
-- set keys that are missing.
UPDATE product_config
   SET badged_processes = badged_processes || jsonb_build_object(
         'assembly_projects', COALESCE((badged_processes ->> 'assembly_projects')::int, 1),
         'assembly_beats',    COALESCE((badged_processes ->> 'assembly_beats')::int,    1)
       )
 WHERE service = '_global'
   AND badged_processes IS NOT NULL
   AND (
        NOT (badged_processes ? 'assembly_projects')
     OR NOT (badged_processes ? 'assembly_beats')
   );
