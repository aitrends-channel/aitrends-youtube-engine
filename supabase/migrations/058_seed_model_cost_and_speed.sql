-- Seed model_cost_and_speed from the existing project_costs ledger so
-- the model picker has cost/speed data the moment the table exists,
-- without waiting for the first daily cron run.
--
-- Mirrors refreshModelCostAndSpeed() in lib/costs.ts:
--   • image_gen rows  → model_type='image', cost_per_unit_credits = MIN(units)
--   • video_gen rows  → model_type='video', cost_per_second_credits =
--     MIN(units / duration_sec) over rows with duration_sec > 0
--   • speed_ms  = AVG(elapsed_ms) over rows with elapsed_ms > 0
--   • sample_count = COUNT(*) of usable (units > 0) rows
--
-- USD columns stay NULL — usd_per_credit hasn't been set yet, and the
-- cron preserves whatever rate is on each row. ON CONFLICT DO NOTHING
-- keeps this idempotent: re-running the migration on a populated
-- table is a no-op, so any admin-set rates aren't clobbered.

WITH image_rows AS (
  SELECT model, units, elapsed_ms
  FROM project_costs
  WHERE step = 'image_gen'
    AND provider = 'kie'
    AND unit_kind = 'kie_credits'
    AND model IS NOT NULL
    AND units > 0
),
image_agg AS (
  SELECT
    model,
    MIN(units) AS cost_per_unit_credits,
    AVG(elapsed_ms) FILTER (WHERE elapsed_ms IS NOT NULL AND elapsed_ms > 0) AS speed_ms,
    COUNT(*) AS sample_count
  FROM image_rows
  GROUP BY model
)
INSERT INTO model_cost_and_speed (
  model_name, model_type, cost_per_unit_credits, speed_ms, sample_count
)
SELECT model, 'image', cost_per_unit_credits, speed_ms, sample_count
FROM image_agg
ON CONFLICT (model_name, model_type) DO NOTHING;

WITH video_rows AS (
  SELECT model, units, duration_sec, elapsed_ms
  FROM project_costs
  WHERE step = 'video_gen'
    AND provider = 'kie'
    AND unit_kind = 'kie_credits'
    AND model IS NOT NULL
    AND units > 0
),
video_agg AS (
  SELECT
    model,
    MIN(units / NULLIF(duration_sec, 0))
      FILTER (WHERE duration_sec IS NOT NULL AND duration_sec > 0) AS cost_per_second_credits,
    AVG(elapsed_ms) FILTER (WHERE elapsed_ms IS NOT NULL AND elapsed_ms > 0) AS speed_ms,
    COUNT(*) AS sample_count
  FROM video_rows
  GROUP BY model
)
INSERT INTO model_cost_and_speed (
  model_name, model_type, cost_per_second_credits, speed_ms, sample_count
)
SELECT model, 'video', cost_per_second_credits, speed_ms, sample_count
FROM video_agg
ON CONFLICT (model_name, model_type) DO NOTHING;
