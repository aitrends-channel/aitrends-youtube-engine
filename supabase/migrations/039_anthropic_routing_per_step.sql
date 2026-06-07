-- Per-step Anthropic routing overrides.
--
-- The existing anthropic_routing column on product_config._global stores
-- the global default (client_kie | heclus_kie | heclus_direct). This
-- migration adds an optional per-step override map so admin can route
-- individual workflow steps differently from the global default.
--
-- Shape: { "<step_slug>": "client_kie" | "heclus_kie" | "heclus_direct" }
-- Recognised step slugs (kept in sync with WorkflowStep in
-- lib/claude/routing.ts):
--   analyze, ideas, script, visual_analysis,
--   image_prompts, video_prompts, thumbnails
--
-- A missing key (or NULL value) for a step means "inherit from the
-- global anthropic_routing setting". An empty {} (the default) is
-- equivalent to the prior single-routing behaviour.

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS anthropic_routing_per_step JSONB NOT NULL DEFAULT '{}'::jsonb;
