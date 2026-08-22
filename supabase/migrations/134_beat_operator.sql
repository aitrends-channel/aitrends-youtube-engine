-- Which provider issued the task id sitting on this beat.
--
-- A task id is only meaningful to the operator that issued it: a KIE id means
-- nothing to another provider's poll or webhook. Recording who issued it removes
-- an assumption that is already load-bearing in two places and already wrong in
-- one of them, and it means adding a provider later is not also a backfill.
--
-- Written once at submit and never rewritten. A task's operator is fixed for the
-- life of that task, which is what lets an admin change which operator new work
-- prefers without redirecting work already in flight to a provider that has
-- never heard of it.
--
-- Three writers, one table, which is why this is one migration:
--   image_operator  – youtube-engine, beside image_task_id (images/submit,
--                     images/regenerate, the one-click orchestrator). KIE is
--                     the only image path.
--   video_operator  – video-worker, beside video_job_id, for the paid KIE lane.
--                   – youtube-engine lib/genaipro/pump.ts, for the free lane.
--
-- That second video writer is the point. video_job_id has always been written by
-- two different providers, and telling them apart meant matching video_model_id
-- against a name prefix, which works only because the free models are named
-- after the provider that runs them.
--
-- Defaults to 'kie' so every pre-existing row is already right. The default also
-- covers the deploy gap: rows written by a build that predates the stamping code
-- land on the operator that actually ran them.

ALTER TABLE project_beats ADD COLUMN IF NOT EXISTS image_operator TEXT NOT NULL DEFAULT 'kie';
ALTER TABLE project_beats ADD COLUMN IF NOT EXISTS video_operator TEXT NOT NULL DEFAULT 'kie';

-- Adding an operator should be a visible schema event rather than a new string
-- appearing in the column, so the allowed set is checked. Extending it is one
-- line in a later migration, which is the right amount of friction: a typo in a
-- stamp would otherwise be stored happily and then match no handler.
ALTER TABLE project_beats DROP CONSTRAINT IF EXISTS project_beats_image_operator_check;
ALTER TABLE project_beats DROP CONSTRAINT IF EXISTS project_beats_video_operator_check;
ALTER TABLE project_beats ADD CONSTRAINT project_beats_image_operator_check
  CHECK (image_operator IN ('kie'));
ALTER TABLE project_beats ADD CONSTRAINT project_beats_video_operator_check
  CHECK (video_operator IN ('kie', 'genaipro'));

-- Backfill the free lane. The default of 'kie' is right for every image row and
-- for paid video, but wrong for video that ran on GenAIPro, and a beat with a
-- live GenAIPro job id labelled 'kie' is exactly the mislabelling this column
-- exists to stop. Matched the way pump.ts already selects its own work.
--
-- Rows whose job has already finished are matched too. Their video_job_id is
-- null so nothing polls them, but leaving them wrong would put a false answer in
-- the per-operator cost breakdown the moment anyone groups on this column.
UPDATE project_beats
   SET video_operator = 'genaipro'
 WHERE video_model_id ILIKE 'genaipro%'
   AND video_operator <> 'genaipro';

-- No index. Nothing filters on operator yet; the in-flight recovery queries
-- still go through the partial indexes from migration 035. Add one alongside
-- the first query that actually needs it.
