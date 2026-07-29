-- Admin-selectable default Claude model (Config → Anthropic → Model).
-- Replaces the hardcoded MODEL constant in lib/claude/client.ts as the
-- source of truth for the workflow steps that ran on it.
--
-- NULL means "use the code fallback" (CLAUDE_MODEL_FALLBACK), so applying
-- this migration changes no behaviour. Unknown ids fall back the same way,
-- which keeps a bad value from taking every Claude call down.
--
-- Deliberately not seeded with a value: the fallback lives in code next to
-- the model catalog, and duplicating it here would mean two places to edit
-- when the shipped default moves.

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS default_claude_model TEXT;

COMMENT ON COLUMN product_config.default_claude_model IS
  'Default Claude model id for workflow steps. NULL or unknown id = the code fallback in lib/claude/models.ts.';
