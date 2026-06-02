-- Routing policy for Anthropic-backed calls (Claude). Admin picks one of:
--   client_kie   → use the user's own KIE key (current behavior; default)
--   heclus_kie   → use Heclus's KIE key (product_config service='heclus_kie_api_key')
--   heclus_direct→ use Heclus's Anthropic key directly, bypassing KIE
--
-- Stored on the same _global singleton that holds founders/limit settings.

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS anthropic_routing TEXT;
