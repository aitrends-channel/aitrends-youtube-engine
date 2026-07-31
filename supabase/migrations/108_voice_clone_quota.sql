-- Per-plan cap on how many voices a user may clone, editable in the admin
-- dashboard under Config → Quotas. Replaces a hardcoded 3-per-user limit
-- in /api/voices/clone.
--
-- Unlike ai33_tts_chars this is a standing allowance, not monthly usage:
-- it counts rows the user currently holds in cloned_voices, and a slot
-- frees when they delete one. Every clone occupies a slot on Heclus's
-- shared ai33 account, so the cap is real capacity, not just spend.
--
-- founder is 0 to match ai33_tts_chars — the admin UI locks founder out of
-- per-plan perk allowances, so a number here would be unreachable anyway.
-- production-test is deliberately absent, like every other quota.

UPDATE product_config
SET free_quotas = COALESCE(free_quotas, '{}'::jsonb) || jsonb_build_object(
  'voice_clones', jsonb_build_object(
    'byPlan', jsonb_build_object('founder', 0, 'starter', 2, 'pro', 5)
  )
)
WHERE service = '_global'
  AND NOT (COALESCE(free_quotas, '{}'::jsonb) ? 'voice_clones');
