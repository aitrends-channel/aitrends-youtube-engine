-- BYO (bring-your-own) free-tier provider credentials.
--
-- The "Free" tab on the generate + voiceover steps runs on providers the
-- user connects with their OWN account, so each client gets their own free
-- daily/monthly quota and aiTrends never pays:
--   • cloudflare_account_id + cloudflare_api_token → Cloudflare Workers AI
--     (free image generation via FLUX Schnell; 10k Neurons/day free).
--   • google_tts_key → Google Cloud Text-to-Speech (free voiceover;
--     1M WaveNet chars/month free).
--
-- Same per-user row + RLS as the existing kie_api_key / elevenlabs_api_key
-- columns on account_settings. No env fallback: these are strictly the
-- user's own keys (never a shared aiTrends key).

ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS cloudflare_account_id TEXT;
ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS cloudflare_api_token TEXT;
ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS google_tts_key TEXT;
