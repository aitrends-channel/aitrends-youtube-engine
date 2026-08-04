-- Gate voice cloning to Pro. 108 seeded Starter at 2, and its guard skips
-- rows that already carry a voice_clones entry, so those databases would
-- keep the old allowance. Set Starter to 0 explicitly.
--
-- The cap stays admin-tunable in Config → Quotas: this changes the
-- starting point, not the mechanism. 0 makes /api/voices/clone answer 403
-- "not included on your plan" and disables the button in the picker.

UPDATE product_config
SET free_quotas = jsonb_set(
  free_quotas,
  '{voice_clones,byPlan,starter}',
  '0'::jsonb,
  true
)
WHERE service = '_global'
  AND free_quotas ? 'voice_clones'
  AND COALESCE(free_quotas #>> '{voice_clones,byPlan,starter}', '0') <> '0';
