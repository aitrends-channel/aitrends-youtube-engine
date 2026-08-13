-- Where "Top up" sends a customer, per Dodo environment.
--
-- The credit-pack product is a Dodo product like any other, and Dodo's test and
-- live modes are separate accounts with separate product ids. One shared column
-- would mean staging checkouts pointing at the live product, or the reverse, so
-- this mirrors how the secret key and base URL are already stored: one value per
-- environment, chosen by the active payment mode.
--
-- Nullable on purpose. With no link the wallet simply shows no top-up button
-- rather than a button that leads nowhere.

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS credit_pack_checkout_url_test       TEXT,
  ADD COLUMN IF NOT EXISTS credit_pack_checkout_url_production TEXT;

COMMENT ON COLUMN product_config.credit_pack_checkout_url_test IS
  'Dodo checkout link for the video-credit pack, test mode. Its return URL must land on a page carrying the wallet, which completes the credit.';
COMMENT ON COLUMN product_config.credit_pack_checkout_url_production IS
  'Dodo checkout link for the video-credit pack, live mode.';
