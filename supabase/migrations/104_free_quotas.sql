-- Admin-tunable free/perk quotas, allocated per plan (Config → Quotas).
-- Replaces the AI33_TTS_CAP_STARTER / _PRO env vars.
--
-- Shape: one entry per quota kind holding a byPlan map of plan slug →
-- allowance. There is no fallback value: a plan with no entry resolves to
-- 0, so we never hand out Heclus-paid characters to a plan nobody
-- configured. See lib/quota-config.ts.
--
-- The seeded numbers match the env baseline the code used before this
-- config existed, so applying this changes no behaviour. production-test
-- is deliberately absent — it's the live-checkout verification harness,
-- not a customer tier.
--
-- Only perks we pay for are allocated here. Qwen isn't reachable in the
-- picker, so it keeps its constants.

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS free_quotas JSONB;

UPDATE product_config
SET free_quotas = '{
  "ai33_tts_chars": { "byPlan": { "founder": 0, "starter": 50000, "pro": 100000 } }
}'::jsonb
WHERE service = '_global' AND free_quotas IS NULL;

COMMENT ON COLUMN product_config.free_quotas IS
  'Admin-tunable free/perk quotas per plan slug. See lib/quota-config.ts — byPlan[slug] is the allowance; a slug with no entry gets 0.';
