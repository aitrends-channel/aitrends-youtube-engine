-- Make the cost meter idempotent, and roll it up in the database.
--
-- Two problems in one table, both about the same 97,000 rows.
--
-- 1. The meter can record one event twice.
--
-- Between 29 June and 6 July, project_costs took exactly 324 image_gen rows an
-- hour, every hour, for seven days: 7,488 z-image rows a day at 0.8 credits and
-- 288 grok at 4. That is not usage, it is an image task whose id never cleared
-- being re-finished by the two-minute cron and logging a cost on every tick,
-- about eleven beats times 720 ticks a day. One project holds 53,785 rows.
--
-- It was harmless because the wallet did not exist yet: those rows were
-- reporting only and nothing was debited. It would not be harmless now.
-- logProjectCost debits, so the same loop today would take about 95,584 credits,
-- roughly $478, out of customer balances over a week, and nothing in the system
-- would stop it.
--
-- event_key is what an event is, rather than what a row is. A provider task id
-- is the natural one: the same task is the same charge, and a genuine retry gets
-- a new task id, so keying on it suppresses loops without suppressing real work.
-- Synchronous calls have no task id and each one is a real new charge, so they
-- default to a random key and are never suppressed.
--
-- NOT NULL with a random default rather than a nullable column and a partial
-- index: Postgres will only use a partial unique index for ON CONFLICT when the
-- statement repeats the index predicate, which PostgREST does not emit. A plain
-- unique index over a column that is always populated works from the client.
--
-- 2. The rollup read the whole table.
--
-- refreshModelCostAndSpeed pages project_costs 1,000 rows at a time to compute a
-- minimum: 102 round trips and 30 seconds today, growing with all-time rows
-- against a 300-second ceiling. model_cost_rollup does the same aggregation in
-- one pass, bounded to a window.
--
-- The window is also more honest. "Cheapest ever observed" reaches back to
-- prices that are no longer charged, and 90 days matches what the rate
-- reconciliation and the token floors already use.

ALTER TABLE project_costs
  ADD COLUMN IF NOT EXISTS event_key TEXT NOT NULL DEFAULT gen_random_uuid()::text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_costs_event_key
  ON project_costs (event_key);

-- The rollup filters by step and scans a date window. There is a
-- (user_id, created_at) index, which does not serve a global window.
CREATE INDEX IF NOT EXISTS idx_project_costs_step_created
  ON project_costs (step, created_at);

-- One row per (model, type, provider, resolution), plus the blended row under
-- resolution '' that every resolution-blind reader still wants. Mirrors the
-- aggregation the TypeScript did, so switching to it changes cost and accuracy
-- rather than meaning.
CREATE OR REPLACE FUNCTION model_cost_rollup(p_days INTEGER DEFAULT 90)
RETURNS TABLE (
  model_name              TEXT,
  model_type              TEXT,
  provider                TEXT,
  resolution              TEXT,
  cost_per_unit_credits   NUMERIC,
  cost_per_second_credits NUMERIC,
  speed_ms                NUMERIC,
  sample_count            BIGINT
)
LANGUAGE sql
STABLE
AS $$
  WITH src AS (
    SELECT
      pc.model                                                    AS model,
      CASE WHEN pc.step = 'video_gen' THEN 'video' ELSE 'image' END AS mtype,
      COALESCE(NULLIF(btrim(pc.provider), ''), 'kie')              AS prov,
      COALESCE(NULLIF(btrim(pc.resolution), ''), '')               AS res,
      pc.units                                                     AS units,
      pc.duration_sec                                              AS duration_sec,
      pc.elapsed_ms                                                AS elapsed_ms
    FROM project_costs pc
    WHERE pc.step IN ('image_gen', 'video_gen')
      AND pc.provider IN ('kie', 'poyo')
      AND pc.unit_kind IN ('kie_credits', 'poyo_credits')
      AND pc.model IS NOT NULL
      AND pc.units > 0
      AND pc.created_at >= now() - make_interval(days => GREATEST(p_days, 1))
  ),
  -- Every observation lands twice: once under its own resolution and once under
  -- the blend. A row with no resolution contributes to the blend only, which is
  -- the whole truth about it.
  expanded AS (
    SELECT model, mtype, prov, ''::text AS res, units, duration_sec, elapsed_ms FROM src
    UNION ALL
    SELECT model, mtype, prov, res, units, duration_sec, elapsed_ms FROM src WHERE res <> ''
  )
  SELECT
    e.model AS model_name,
    e.mtype AS model_type,
    e.prov  AS provider,
    e.res   AS resolution,
    -- FILTER rather than CASE so the wrong-shaped column comes out NULL, which
    -- is what the image_has_per_unit and video_has_per_second checks require.
    MIN(e.units) FILTER (WHERE e.mtype = 'image')                       AS cost_per_unit_credits,
    MIN(e.units / e.duration_sec) FILTER (
      WHERE e.mtype = 'video' AND e.duration_sec IS NOT NULL AND e.duration_sec > 0
    )                                                                   AS cost_per_second_credits,
    AVG(e.elapsed_ms) FILTER (WHERE e.elapsed_ms IS NOT NULL AND e.elapsed_ms > 0) AS speed_ms,
    COUNT(*)                                                            AS sample_count
  FROM expanded e
  GROUP BY e.model, e.mtype, e.prov, e.res
$$;
