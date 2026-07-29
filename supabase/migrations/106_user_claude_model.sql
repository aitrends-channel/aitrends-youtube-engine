-- Let Pro users pick the Claude model for the prompt-generation steps.
--
-- Two halves:
--   • product_config.user_selectable_claude_models — the admin allowlist of
--     model ids a user may choose from (Config → Anthropic → Model). Empty
--     array = the feature is off and every user runs the admin default, so
--     applying this migration changes no behaviour.
--   • account_settings.claude_model — the user's pick. NULL, an id no longer
--     on the allowlist, or a non-Pro plan all fall back to the admin default.
--
-- Deliberately scoped: a user's pick only applies to the image / video /
-- thumbnail prompt steps, and only when that step routes through the user's
-- own KIE key (client_kie), so a user can never spend Heclus's key on a
-- model they chose. See lib/claude/models.ts for the resolution order.

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS user_selectable_claude_models JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE account_settings
  ADD COLUMN IF NOT EXISTS claude_model TEXT;

COMMENT ON COLUMN product_config.user_selectable_claude_models IS
  'Admin allowlist of Claude model ids Pro users may choose. Empty = feature off. See lib/claude/models.ts.';

COMMENT ON COLUMN account_settings.claude_model IS
  'User-chosen Claude model for the prompt steps. Honoured only for Pro plans, allowlisted ids, and client_kie routing.';
