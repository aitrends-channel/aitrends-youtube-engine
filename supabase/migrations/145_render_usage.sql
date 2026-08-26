-- What an assemble cost us to run.
--
-- Separate from project_costs on purpose. Every row there is a vendor's charge
-- in a vendor's unit, and the rollups, the price-drift reconciler and the
-- credit conversion all assume that. This is our own infrastructure, measured
-- rather than invoiced, and folding it in would put a number nobody billed us
-- into the tables that check what we were billed.
--
-- Nothing here charges a customer. It answers "what does a 4K assemble actually
-- cost", which is the question that has to be answered before anyone could be
-- charged for one, and today the render is the largest thing we run and the
-- only step that reaches no ledger at all.

CREATE TABLE IF NOT EXISTS render_usage (
  id             BIGSERIAL PRIMARY KEY,
  project_id     UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id        UUID        NOT NULL,

  resolution     TEXT,
  -- Length of the finished video. The denominator for a per-second rate, and
  -- the figure a customer could be charged on, since it is the one they can
  -- predict before the render starts.
  output_seconds NUMERIC,

  -- Wall clock for the whole assemble, including downloads and uploads.
  wall_ms        INTEGER     NOT NULL,
  -- Summed utime+stime across every ffmpeg the assemble spawned, read from
  -- /proc. A floor: an encode shorter than the sampler's interval contributes
  -- nothing, which is what unsampled_encodes records.
  cpu_seconds    NUMERIC     NOT NULL,
  -- The tallest VmHWM any single ffmpeg reached. Not a sum: what sizes the box
  -- is the biggest concurrent peak, not the total across a sequence.
  peak_rss_mb    NUMERIC,
  encodes        INTEGER     NOT NULL DEFAULT 0,
  unsampled_encodes INTEGER  NOT NULL DEFAULT 0,

  -- Null until render rates are configured. Deliberately not defaulted to a
  -- guess: a made-up instance price would look like a measurement.
  usd_cost       NUMERIC,
  -- The rates this row's usd_cost was computed with. Kept so a later correction
  -- reprices new rows without silently rewriting what old ones claimed to cost.
  usd_rates      JSONB,

  succeeded      BOOLEAN     NOT NULL DEFAULT true,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS render_usage_user_time
  ON render_usage (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS render_usage_project
  ON render_usage (project_id);

-- Answering "what does this resolution cost per output second" is the whole
-- point, and it is always filtered by resolution over a time window.
CREATE INDEX IF NOT EXISTS render_usage_resolution_time
  ON render_usage (resolution, created_at DESC);

COMMENT ON TABLE render_usage IS
  'Measured CPU, peak memory and wall clock per video assemble, with a costed '
  'equivalent when render rates are configured. Our own infrastructure usage, '
  'not a vendor charge: see project_costs for those.';
