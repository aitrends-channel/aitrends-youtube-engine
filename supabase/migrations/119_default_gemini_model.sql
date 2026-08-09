-- Gemini as a third provider for the prompt steps.
--
-- Migration 118 added prompt_provider_per_step ("claude" | "gpt") and
-- default_gpt_model. This adds the Gemini counterpart. The per-step map now
-- also accepts "gemini"; no change is needed there since it stores free-form
-- text validated in code (lib/claude/providers.ts).
--
-- Why a third option: the two KIE relays fail independently, and they trade off
-- differently. Measured on a production-scale 200-word chunk (20 beats out):
--
--   gpt-5-6-luna     ~60s   ~0.25 credits   fine-grained streaming, but a
--                                           meaningful share of calls return
--                                           an empty body and need a retry
--   gemini-3-flash   ~19s   ~1.2 credits    fastest and reliable, but arrives
--                                           in one chunk so the beat-progress
--                                           bar doesn't move mid-chunk
--   gemini-3.1-pro   ~53s   ~1.8 credits    reliable, streams in ~50 pieces
--
-- NULL or an unknown id falls back to the code default, same rule as
-- default_claude_model and default_gpt_model, so one bad value can't take the
-- step down.

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS default_gemini_model TEXT;

COMMENT ON COLUMN product_config.default_gemini_model IS
  'Gemini model id used when a step''s provider is gemini. NULL or unknown id = the code fallback in lib/claude/providers.ts.';

COMMENT ON COLUMN product_config.prompt_provider_per_step IS
  'Per-step model provider override: { "<step_slug>": "claude" | "gpt" | "gemini" }. Only image_prompts, video_prompts and beats are honoured. Missing key = claude.';
