-- A Claude model pinned to particular workflow steps.
--
-- Until now one model ran every writing step. That is the wrong shape for the
-- prompts run: it is the highest-volume Claude work in the product by a wide
-- margin, so it is the one step where a cheaper model pays for itself, and the
-- one where the admin default is most likely to be the wrong trade.
--
-- Keyed by workflow step rather than by group, matching anthropic_routing_per_step
-- and prompt_provider_per_step next to it. The admin UI writes the three prompt
-- steps together because that is one decision to a person, but the storage does
-- not need to know that.
--
-- An absent key means the step runs on default_claude_model, which is what
-- every step did before this column existed. Empty default, so nothing changes
-- on deploy.

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS claude_model_per_step JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN product_config.claude_model_per_step IS
  'Workflow step to Claude model id, for steps that should not run on default_claude_model. Filtered against the model catalog on read, so a retired id falls back to the default rather than reaching the API.';
