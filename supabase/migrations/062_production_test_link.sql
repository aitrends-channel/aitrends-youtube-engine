-- Admin-only "Production test" checkout URL. Stored on the singleton
-- product_config._global row alongside dodo_payment_mode. Surfaces as
-- a 4th row on the admin Plans tab when mode is 'production' so the
-- admin can fire a real production checkout for sanity-checking
-- without exposing the SKU to customers.
--
-- Schema-only change: no seed. Admin enters the URL via the row's
-- edit button on the Plans tab.

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS dodo_production_test_link TEXT;
