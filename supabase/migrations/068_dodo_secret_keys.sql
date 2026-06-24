-- Admin-managed Dodo API secret keys and base URLs, one per
-- environment. Lives alongside the existing dodo_payment_mode /
-- dodo_production_test_link on the product_config._global singleton
-- row.
--
-- The verify route prefers these DB values over DODO_SECRET_KEY /
-- DODO_BASE_URL when present so admins can swap keys or repoint at
-- a different Dodo host without a redeploy, and so verify can pick
-- the right key by environment when both test plans and the live
-- production-test plan are in play at once. Env vars stay as a
-- fallback for first-deploy bootstrap.
--
-- All four columns are nullable. A fresh install carries nothing
-- and the route falls through to env vars (then hardcoded defaults
-- for the base URLs) until the admin pastes them via the new "Dodo
-- API keys" card on the Plans tab.

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS dodo_secret_key_test         TEXT,
  ADD COLUMN IF NOT EXISTS dodo_secret_key_production   TEXT,
  ADD COLUMN IF NOT EXISTS dodo_base_url_test           TEXT,
  ADD COLUMN IF NOT EXISTS dodo_base_url_production     TEXT,
  ADD COLUMN IF NOT EXISTS dodo_webhook_secret_test     TEXT,
  ADD COLUMN IF NOT EXISTS dodo_webhook_secret_production TEXT;
