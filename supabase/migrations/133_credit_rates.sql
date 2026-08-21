-- What a provider unit costs in Heclus Credits.
--
-- One credit is one KIE credit, so images, videos and KIE-mediated Claude calls
-- need no rate at all. This row is for the two units that are not KIE's:
-- Anthropic tokens on heclus_direct steps, and ElevenLabs characters.
--
-- A column so a provider price change is a settings edit rather than a deploy.
-- NULL means "use the defaults in lib/pricing.ts", which are deliberately on the
-- safe side of what Heclus actually pays.
ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS credit_rates JSONB;

COMMENT ON COLUMN product_config.credit_rates IS
  'Overrides for DEFAULT_CREDIT_RATES in lib/pricing.ts. Keys: perKieCredit, perMillionTokensIn, perMillionTokensOut, perMillionTokensCacheRead, perMillionTokensCacheWrite, perThousandTtsChars. Unknown keys and non-numeric values are ignored; NULL uses the code defaults.';
