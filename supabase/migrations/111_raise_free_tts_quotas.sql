-- Double the free voiceover allowances: Starter 50k → 100k chars/month,
-- Pro 100k → 200k. Founder stays 0 (no Heclus-paid perk on that tier).
--
-- The env fallbacks in lib/quota-config.ts move with these so a database
-- without the row resolves to the same numbers. This is real spend on our
-- own provider account, so the caps stay bounded — unlike voice_clones,
-- which accepts -1.
--
-- jsonb_set with create_missing=true, so it works whether or not the
-- byPlan entries already exist.

UPDATE product_config
SET free_quotas = jsonb_set(
  jsonb_set(
    COALESCE(free_quotas, '{}'::jsonb),
    '{ai33_tts_chars,byPlan,starter}',
    to_jsonb(100000),
    true
  ),
  '{ai33_tts_chars,byPlan,pro}',
  to_jsonb(200000),
  true
)
WHERE service = '_global';
