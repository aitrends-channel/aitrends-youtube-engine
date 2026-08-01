-- Unlimited cloning for Pro; Starter stays 0 so the feature ships to Pro
-- only for now. -1 is the unlimited sentinel (lib/quota-config.ts:
-- QUOTA_UNLIMITED) and is accepted only on fields flagged allowUnlimited,
-- which is voice_clones alone — character allowances are per-unit spend
-- and must stay bounded.
--
-- 0 and -1 are deliberately distinct: 0 means "not included on this plan"
-- and drives the Pro gate in the picker plus a 403 from /api/voices/clone.
--
-- Supersedes the numeric caps seeded by 108/109. Both plans are still
-- admin-tunable in Config → Quotas, so opening cloning to Starter later
-- is a config change rather than a deploy.

UPDATE product_config
SET free_quotas = jsonb_set(
  jsonb_set(
    free_quotas,
    '{voice_clones,byPlan,pro}',
    to_jsonb(-1),
    true
  ),
  '{voice_clones,byPlan,starter}',
  to_jsonb(0),
  true
)
WHERE service = '_global'
  AND free_quotas ? 'voice_clones';
