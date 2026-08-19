-- The Heclus Credits top-up pack.
--
-- Its own link and its own numbers, deliberately not the video pack's. That one
-- credits genai_credits: pointing the general wallet's button at it would charge
-- a customer for Heclus Credits and hand them video clips instead, which is the
-- kind of bug you only find in a support ticket.
--
-- Per environment, like every other Dodo link here, so a test checkout cannot
-- take live money.
ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS heclus_pack_checkout_url_test TEXT;

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS heclus_pack_checkout_url_production TEXT;

-- What one purchase grants and costs. Columns rather than code constants
-- because this is a price: it changes without a deploy, and the number a
-- customer was shown has to be the number they were charged.
ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS heclus_pack_credits NUMERIC(14,4);

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS heclus_pack_price_usd NUMERIC(10,2);

COMMENT ON COLUMN product_config.heclus_pack_credits IS
  'Heclus Credits granted by one top-up. NULL means no pack is configured, and the Balance page shows the button disabled rather than sending a customer to a checkout that grants nothing.';
