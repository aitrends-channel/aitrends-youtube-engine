-- Promote the synthetic SubscriptionModal "Production test" card to a
-- real plans row. Previously it lived as client-side synthesis driven
-- by product_config.dodo_production_test_link; now it's just another
-- entry in the plans table so admins can edit name / features / links
-- through the standard Plans editor instead of a one-off UI.
--
-- sort_order=999 keeps it after the three customer tiers regardless
-- of how new tiers slot in. niches_per_month=NULL because the plan
-- is purely a checkout-flow harness — no quota math runs against it.
-- disabled=false so it's selectable; admins decide visibility by
-- whether they keep payment_link_production set.
--
-- Backfill: if dodo_production_test_link is already set on
-- product_config._global, copy it into the new plan's
-- payment_link_production so existing environments don't lose their
-- working test URL on deploy. The product_config column stays
-- in place (legacy admin UI still reads it) — a later cleanup
-- migration can drop it once the standalone "Production test" admin
-- row on the Plans tab is removed.

INSERT INTO plans (
  slug, name, price_display, period_display, limit_display,
  features, niches_per_month, highlighted, disabled, is_founder, sort_order
) VALUES (
  'production-test', 'Production test', 'Test', '', 'Verification only',
  '["Live Dodo production checkout","For verifying the production payment flow end-to-end"]'::jsonb,
  NULL, false, false, false, 999
)
ON CONFLICT (slug) DO NOTHING;

UPDATE plans
SET payment_link_production = (
  SELECT dodo_production_test_link
  FROM product_config
  WHERE service = '_global'
)
WHERE slug = 'production-test'
  AND payment_link_production IS NULL
  AND EXISTS (
    SELECT 1 FROM product_config
    WHERE service = '_global' AND dodo_production_test_link IS NOT NULL
  );
