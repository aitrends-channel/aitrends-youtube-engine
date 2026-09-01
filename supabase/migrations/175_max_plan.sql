-- The Max plan: a third tier above Pro.
--
-- Why a third tier at all, from the production ledger rather than from a guess.
-- Across 467 projects with real spend, at $0.005 a credit:
--
--   image-only projects   (68%)  median   247 credits  ($1.23)
--   projects using AI video (32%) median 2,211 credits ($11.06), p90 8,028 ($40)
--
-- An AI-video project costs about nine times an image-only one, and Pro's 2,000
-- credits fund fewer than one of them while its niche allowance promises ten.
-- Max exists for the customer that ratio describes: the one generating video,
-- for whom Pro is a wall rather than a plan.
--
-- 10,000 credits is $50 of provider spend against $129, so 61% at full burn and
-- higher for everyone who does not exhaust it. The niche cap goes away because
-- credits already bind long before it.

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS heclus_signup_grant_credits_max NUMERIC;

UPDATE product_config
   SET heclus_signup_grant_credits_max = 10000
 WHERE service = '_global'
   AND heclus_signup_grant_credits_max IS NULL;

-- Disabled until the Dodo product exists: getPlans lists it, and a tier with no
-- payment link is an upgrade button that goes nowhere. Flip disabled to false in
-- the same change that fills in the two links.
INSERT INTO plans (
  slug, name, price_display, price_cents, period_display, limit_display,
  features, niches_per_month, payment_link_test, payment_link_production,
  highlighted, disabled, legacy, is_founder, sort_order
) VALUES (
  'heclus_max', 'Max', '$129', 12900, '/mo', 'Unlimited niches',
  '["Everything in Pro",
    "Unlimited niches",
    "10,000 Heclus Credits / month",
    "4K output",
    "Transitions, motion and the full effects library",
    "Text overlays, elements and sound effects",
    "Multi-track timeline editing",
    "Priority rendering queue",
    "Priority support"]'::jsonb,
  NULL, NULL, NULL,
  false, true, false, false, 3
)
ON CONFLICT (slug) DO NOTHING;
