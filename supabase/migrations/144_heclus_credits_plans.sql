-- The Heclus Credits plans, and a way to retire a plan without deleting it.
--
-- heclus_starter and heclus_pro sell the existing tiers at the Heclus Credits
-- price. Every new signup lands on them; customers already on starter or pro
-- keep those products and those prices until they choose to switch.
--
-- Two reasons the old rows cannot simply be edited or removed:
--
--   getPlanBySlug carries entitlements, not just display. app/api/projects
--   reads niches_per_month from it for the project cap, and a slug with no row
--   falls back to the Starter cap. So a grandfathered pro customer needs their
--   row to keep existing, and a heclus_pro customer needs one to exist at all
--   or they silently get the Starter cap.
--
--   disabled already means something else. The subscription modal renders a
--   disabled plan as a greyed card, which is right for "sold out" and wrong for
--   "retired": a new customer should not see a greyed Starter $21 next to the
--   plan they can actually buy.
--
-- So `legacy` hides a plan from the public list while leaving it fully
-- resolvable for the customers still on it. getPlans filters it; getPlanBySlug
-- deliberately does not.
--
-- The new rows copy features, limits and niches_per_month from the plans they
-- replace, in SQL rather than by hand, so the tiers cannot drift apart. What
-- they do NOT carry is a price or a checkout link: those are commercial values
-- and belong to whoever sets them in Admin, Plans. Both rows are inserted
-- disabled so nothing can be bought at a placeholder price by accident.

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS legacy BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN plans.legacy IS
  'Retired from the public plan list. Still resolvable by slug so existing '
  'subscribers keep their entitlements. Distinct from disabled, which greys the '
  'card rather than removing it.';

INSERT INTO plans (
  slug, name, price_display, period_display, limit_display, features,
  niches_per_month, highlighted, disabled, is_founder, sort_order, legacy
)
SELECT
  'heclus_' || p.slug,
  p.name,
  -- Deliberately not a price. Set it in Admin, Plans alongside the checkout
  -- links; until then the card cannot mislead anyone.
  'Set price',
  p.period_display,
  p.limit_display,
  p.features,
  p.niches_per_month,
  p.highlighted,
  true,
  false,
  p.sort_order,
  false
FROM plans p
WHERE p.slug IN ('starter', 'pro')
ON CONFLICT (slug) DO NOTHING;

-- The old products stay sellable to nobody new, and unchanged for everyone on
-- them. Founder is already closed and needs no flag; production-test is the
-- live-checkout harness and is not a customer tier.
UPDATE plans SET legacy = true WHERE slug IN ('starter', 'pro');
