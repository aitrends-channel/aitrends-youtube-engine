-- Seed Dodo payment links into the plans table. Kept in a separate
-- migration from 059 so the URLs can be overwritten per-environment
-- without rewriting the schema seed.
--
-- IMPORTANT: these are TEST-mode links (test.checkout.dodopayments.com).
-- They were the values present in the local .env at the time of this
-- migration. Real users hitting Subscribe on production will land in
-- test checkout until an admin replaces these with production URLs
-- via the Config → Plans tab.
--
-- Each UPDATE is guarded with WHERE payment_link IS NULL so the
-- migration is idempotent and doesn't clobber any link an admin has
-- already set through the UI.

UPDATE plans
SET payment_link = 'https://test.checkout.dodopayments.com/buy/pdt_0NfgBQzKKtNpmkKMAPuzr?quantity=1'
WHERE slug = 'founder' AND payment_link IS NULL;

UPDATE plans
SET payment_link = 'https://test.checkout.dodopayments.com/buy/pdt_0NfkFVG4ZiMViybqR9XcB?quantity=1'
WHERE slug = 'starter' AND payment_link IS NULL;

UPDATE plans
SET payment_link = 'https://test.checkout.dodopayments.com/buy/pdt_0NfkGTa0Tu3WHl2mMlVKc?quantity=1'
WHERE slug = 'pro' AND payment_link IS NULL;
