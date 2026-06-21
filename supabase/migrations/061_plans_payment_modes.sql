-- Split the single payment_link column on plans into separate
-- payment_link_test and payment_link_production columns, and add a
-- global dodo_payment_mode setting on product_config so the admin
-- can toggle which set of links the SubscriptionModal consumes.
--
-- Backfill rule: the existing payment_link values were seeded from
-- .env in migration 060 and those URLs were test-mode
-- (test.checkout.dodopayments.com/...). They get copied into
-- payment_link_test; payment_link_production stays NULL until an
-- admin pastes the real ones in the Plans tab. Default mode = 'test'
-- so behavior on first deploy matches what users saw before this
-- change.
--
-- The mode lives on the singleton product_config._global row,
-- alongside anthropic_routing, default_image_model, etc. (see
-- migration 028 for the established pattern).

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS payment_link_test       TEXT,
  ADD COLUMN IF NOT EXISTS payment_link_production TEXT;

UPDATE plans
SET payment_link_test = payment_link
WHERE payment_link IS NOT NULL AND payment_link_test IS NULL;

ALTER TABLE plans DROP COLUMN IF EXISTS payment_link;

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS dodo_payment_mode TEXT;

-- Constrain to the two valid values. Done as a separate ALTER so the
-- ADD COLUMN above stays IF NOT EXISTS-safe on re-runs.
ALTER TABLE product_config
  DROP CONSTRAINT IF EXISTS product_config_dodo_payment_mode_check;
ALTER TABLE product_config
  ADD CONSTRAINT product_config_dodo_payment_mode_check
  CHECK (dodo_payment_mode IS NULL OR dodo_payment_mode IN ('test', 'production'));

-- Seed the _global singleton with mode='test' if it exists and the
-- value is unset. If the row is missing entirely, create it.
--
-- Split into UPDATE + INSERT-WHERE-NOT-EXISTS instead of using
-- ON CONFLICT because product_config was created outside migrations
-- without a unique constraint on service — the upsert form would
-- raise "no unique or exclusion constraint matching the ON CONFLICT
-- specification" (42P10).
UPDATE product_config
   SET dodo_payment_mode = 'test'
 WHERE service = '_global'
   AND dodo_payment_mode IS NULL;

INSERT INTO product_config (service, dodo_payment_mode)
SELECT '_global', 'test'
 WHERE NOT EXISTS (SELECT 1 FROM product_config WHERE service = '_global');
