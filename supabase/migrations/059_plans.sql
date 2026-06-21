-- Move the subscription plans from a hardcoded TS array
-- (components/SubscriptionModal.tsx) + duplicated PLAN_LIMITS consts
-- (in three API routes) into a single admin-editable table.
--
-- The slug is the primary key on purpose: it's already what gets
-- written into auth.users.app_metadata.plan by the Dodo webhook, so
-- using anything else (e.g. a generated id) would force a join on
-- every limit-check call. Renaming a slug after creation would orphan
-- paid users, so the admin UI keeps the slug read-only post-create.
--
-- niches_per_month: NULL means unlimited (matches the existing
--   PLAN_LIMITS shape — pro is null today). Server-side enforcement in
--   try_use_niche treats NULL as "no cap".
--
-- is_founder marks the plan that triggers the founder slot mechanic
-- (founders_subscriptions_count + claim_founder_spot RPC). Only one
-- plan should have this true at a time, but we don't enforce that in
-- the schema — it's an admin-discipline thing, not a correctness one.
--
-- features is JSONB for shape flexibility — currently a string array
-- of bullet lines, but JSONB lets us add per-feature metadata later
-- (icons, tooltips) without another migration.

CREATE TABLE IF NOT EXISTS plans (
  slug              TEXT        PRIMARY KEY,
  name              TEXT        NOT NULL,
  price_display     TEXT        NOT NULL,
  period_display    TEXT        NOT NULL DEFAULT '',
  limit_display     TEXT        NOT NULL DEFAULT '',
  features          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  niches_per_month  INTEGER,
  payment_link      TEXT,
  highlighted       BOOLEAN     NOT NULL DEFAULT false,
  disabled          BOOLEAN     NOT NULL DEFAULT false,
  is_founder        BOOLEAN     NOT NULL DEFAULT false,
  sort_order        INTEGER     NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed with the exact current values from SubscriptionModal.tsx +
-- PLAN_LIMITS so the behavior on first deploy is byte-identical to
-- what's in production today. ON CONFLICT DO NOTHING keeps the
-- migration idempotent — re-running won't clobber admin edits.

INSERT INTO plans (
  slug, name, price_display, period_display, limit_display,
  features, niches_per_month, highlighted, disabled, is_founder, sort_order
) VALUES
  (
    'founder', 'Founder', '$40', ' / year', '1 year · 20 niches',
    '["20 niches","HD image processing","Full AI pipeline","All features included","1 year — no renewal"]'::jsonb,
    20, false, false, true, 0
  ),
  (
    'starter', 'Starter', '$19', '/mo', '5 niches/month',
    '["5 niches/month","Standard image processing","Full AI pipeline","All features included","Community support"]'::jsonb,
    5, false, false, false, 1
  ),
  (
    'pro', 'Pro', '$49', '/mo', 'Unlimited niches',
    '["Everything in Starter","Clone unlimited YouTube niches","Unlimited video creation","Bulk video generation","Priority rendering queue","Priority support"]'::jsonb,
    NULL, true, false, false, 2
  )
ON CONFLICT (slug) DO NOTHING;

-- Keep updated_at honest without forcing every route to set it.
CREATE OR REPLACE FUNCTION plans_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS plans_touch_updated_at_trigger ON plans;
CREATE TRIGGER plans_touch_updated_at_trigger
  BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION plans_touch_updated_at();
