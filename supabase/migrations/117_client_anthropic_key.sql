-- BYO Anthropic key: let a client run their Claude calls on their own
-- Anthropic account instead of through their KIE key.
--
-- Why a client would want it: KIE resells Claude, so it adds a margin, a
-- credit system and its own failure modes (envelope quirks, silent streams,
-- paused models). A client with an Anthropic account can skip all of that and
-- be billed by Anthropic in tokens.
--
-- Two columns, not one, so the choice is reversible without deleting the key:
--
--   anthropic_api_key       the key itself. No env fallback — strictly the
--                           user's own, same rule as the free-tier BYO keys.
--   anthropic_direct_enabled  whether to actually use it. Defaults to FALSE so
--                           saving a key never silently moves who pays; the
--                           client turns it on deliberately and can turn it
--                           back off without re-pasting the key.
--
-- This only applies where the CLIENT's key already pays — routing resolved to
-- client_kie. When an admin has routed a step to heclus_kie or heclus_direct,
-- Heclus is deliberately covering it and the client's key stays untouched.

ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS anthropic_api_key TEXT;
ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS anthropic_direct_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN account_settings.anthropic_api_key IS
  'Client''s own Anthropic API key. Used only when anthropic_direct_enabled is true AND the step routes client_kie.';
COMMENT ON COLUMN account_settings.anthropic_direct_enabled IS
  'Client opted to run Claude calls on their own Anthropic key instead of their KIE key.';
