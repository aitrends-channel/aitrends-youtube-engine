-- BYO Google AI Studio (Gemini) API key — powers the free-tier Gemini
-- image model (gemini-2.5-flash-image, "Nano Banana") on the USER's own
-- AI Studio free quota. Deliberately NOT hardcoding any request/day cap:
-- Google's free-tier limits are account- and tier-dependent and vary, so
-- the generate path surfaces Google's own 429 message instead of
-- tracking an assumed number. Same per-user row + RLS as the other
-- account_settings key columns.

ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS gemini_api_key TEXT;
