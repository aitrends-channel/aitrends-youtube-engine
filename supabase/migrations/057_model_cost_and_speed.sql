-- Global, daily-refreshed snapshot of per-model cost and speed.
--
-- This table is the source of truth the model picker reads from. The
-- raw observations still live in project_costs (one row per upstream
-- call); a daily cron rolls them up into one row per (model, type)
-- here so the picker doesn't have to re-aggregate the ledger on every
-- page load.
--
-- Two cost shapes:
--   • image models — cost_per_unit_* is the minimum observed KIE
--     credit charge for a single generation. cost_per_second_* is
--     NULL.
--   • video models — cost_per_second_* is the minimum observed
--     credits/sec (units / duration_sec). cost_per_unit_* is NULL.
--
-- usd_per_credit is stored per-row so the rate can vary by model if
-- KIE ever changes how a specific endpoint bills. The refresh job
-- preserves whatever value is already on the row (admin-editable);
-- only the credit and speed columns are overwritten from project_costs.
-- USD columns are derived = credits * usd_per_credit, and stay NULL
-- when the rate hasn't been set.
--
-- speed_ms is the average wall-clock elapsed time across all observed
-- generations for that model. Mirrors getAvgElapsedByModel's behavior.

CREATE TABLE IF NOT EXISTS model_cost_and_speed (
  model_name              TEXT        NOT NULL,
  model_type              TEXT        NOT NULL CHECK (model_type IN ('image', 'video')),
  cost_per_unit_credits   NUMERIC,
  cost_per_unit_usd       NUMERIC,
  cost_per_second_credits NUMERIC,
  cost_per_second_usd     NUMERIC,
  usd_per_credit          NUMERIC,
  speed_ms                NUMERIC,
  sample_count            INTEGER     NOT NULL DEFAULT 0,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (model_name, model_type),
  CONSTRAINT image_has_per_unit CHECK (
    model_type <> 'image' OR cost_per_second_credits IS NULL
  ),
  CONSTRAINT video_has_per_second CHECK (
    model_type <> 'video' OR cost_per_unit_credits IS NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_model_cost_and_speed_type
  ON model_cost_and_speed (model_type);
