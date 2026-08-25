-- Give the cost snapshot a provider axis.
--
-- model_cost_and_speed has held one row per model, and the rollup that fills it
-- reads KIE rows only. That was not a preference: both catalogs carry a model
-- called z-image and both carry seedream-4, priced differently and billed in
-- different currencies, so folding PoYo in without a provider column would take
-- a MIN across two vendors under one name.
--
-- The cost of leaving it out is that PoYo has no observed prices at all. PoYo
-- images fall back to their published catalog, which is a price list and goes
-- stale; PoYo video reads the KIE figure for the same relayed model, which runs
-- high because PoYo relays below KIE list. Neither is measured.
--
-- 'kie' is the default so every existing row keeps its meaning, including the
-- hand-seeded ElevenLabs TTS rate that lives in this table for want of a better
-- home.

ALTER TABLE model_cost_and_speed
  ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'kie';

ALTER TABLE model_cost_and_speed
  DROP CONSTRAINT IF EXISTS model_cost_and_speed_pkey;

ALTER TABLE model_cost_and_speed
  ADD PRIMARY KEY (model_name, model_type, provider, resolution);

-- Readers filter provider and type first, then resolution.
CREATE INDEX IF NOT EXISTS idx_model_cost_and_speed_provider_type
  ON model_cost_and_speed (provider, model_type, resolution);

-- The two credit currencies both price at $0.005 today, but they are two
-- vendors' units and either can reprice alone. usd_per_credit is already
-- per-row, so a PoYo row can carry its own rate the moment that happens.
