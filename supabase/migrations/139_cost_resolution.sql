-- Record which resolution a generation was billed at.
--
-- The ledger has never carried this. Every observation for a model was blended
-- into one figure and the rollup kept the MINIMUM of it, so a 4K clip was
-- estimated at the cheapest resolution that model had ever been run at. The
-- wallet then held that figure, and credits_settle caps a settle at the hold
-- ("never settle for more than was held"), so the difference came out of
-- Heclus rather than the user's balance. Estimating from a blend of
-- resolutions is the root of it, and no column meant no way to stop.
--
-- Three parts:
--
--   1. project_costs.resolution — the raw observation. Nullable, because rows
--      predating this migration genuinely do not know, and a made-up value
--      would be worse than an absent one.
--
--   2. model_cost_and_speed.resolution — the rollup key. '' (not NULL) means
--      "every resolution blended", which is exactly the row the table held
--      before today, so existing rows keep their meaning and every reader that
--      does not ask for a resolution keeps working. NULL would have to be
--      excluded from the primary key.
--
--   3. project_beats.image_resolution — images submit on one request and
--      finish on another (webhook, poll or cron), and the finisher is where
--      the cost is logged. Videos already carry video_resolution from
--      migration 091; images had nowhere to put it, so the async path could
--      not have stamped a resolution even with the column above.

ALTER TABLE project_costs
  ADD COLUMN IF NOT EXISTS resolution TEXT;

ALTER TABLE project_beats
  ADD COLUMN IF NOT EXISTS image_resolution TEXT;

ALTER TABLE model_cost_and_speed
  ADD COLUMN IF NOT EXISTS resolution TEXT NOT NULL DEFAULT '';

-- The blended row keeps the identity the old key gave it; the per-resolution
-- rows are new siblings beside it.
ALTER TABLE model_cost_and_speed
  DROP CONSTRAINT IF EXISTS model_cost_and_speed_pkey;

ALTER TABLE model_cost_and_speed
  ADD PRIMARY KEY (model_name, model_type, resolution);

-- Readers filter on type and then resolution, in that order.
CREATE INDEX IF NOT EXISTS idx_model_cost_and_speed_type_resolution
  ON model_cost_and_speed (model_type, resolution);

-- The per-resolution rollup reads project_costs by step and resolution over a
-- date window. Without this it is a full scan of the ledger on every refresh.
CREATE INDEX IF NOT EXISTS idx_project_costs_step_resolution
  ON project_costs (step, resolution);
