-- Per-step model provider: run the prompt steps on GPT instead of Claude.
--
-- Routing (anthropic_routing / anthropic_routing_per_step) answers "whose key
-- pays and through which gateway". This answers a different question: "which
-- model family generates the output". They're orthogonal, which is why this is
-- a separate map rather than another routing value.
--
-- Why it exists: KIE resells both, and its Claude relay
-- (api.kie.ai/claude/v1/messages) fails independently of its GPT relay
-- (api.kie.ai/codex/v1/responses). When Claude is down, the prompt grind can
-- keep running on the same KIE key instead of falling back to Heclus's
-- Anthropic key. It doubles as a cost lever — GPT ran the production image
-- prompt schema at ~0.04 credits per chunk.
--
--   prompt_provider_per_step  { "<step_slug>": "claude" | "gpt" }
--     Only image_prompts and video_prompts are honoured (PROVIDER_STEPS in
--     lib/claude/providers.ts). A missing key means Claude, so applying this
--     migration changes no behaviour.
--
--   default_gpt_model         which GPT model the gpt provider runs on.
--     NULL or an unknown id falls back to the code default, same rule as
--     default_claude_model, so one bad value can't take the step down.
--
-- GPT is only reachable through KIE, so selecting it maps a direct-to-Anthropic
-- routing to its KIE equivalent (heclus_direct → heclus_kie, client_direct →
-- client_kie). Whose key pays is unchanged; only the gateway is.

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS prompt_provider_per_step JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS default_gpt_model TEXT;

COMMENT ON COLUMN product_config.prompt_provider_per_step IS
  'Per-step model provider override: { "<step_slug>": "claude" | "gpt" }. Only image_prompts and video_prompts are honoured. Missing key = claude.';

COMMENT ON COLUMN product_config.default_gpt_model IS
  'GPT model id used when a step''s provider is gpt. NULL or unknown id = the code fallback in lib/claude/providers.ts.';
