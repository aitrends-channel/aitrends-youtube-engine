-- Which media operator serves new work.
--
-- The switch the operator column in migration 134 was built to make safe. That
-- one records who ran a task so work in flight finishes with the provider
-- holding it; this one decides where the next task goes. Both are needed: a
-- switch without the stamp reroutes live tasks to a provider that never issued
-- their ids, and every open credit reservation leaks.
--
-- Deliberately the same shape as anthropic_routing (migration 028) and
-- anthropic_routing_per_step (039): a global default plus an optional override
-- map, resolved at call time with a hardcoded fallback. Admin already has one
-- card that works this way and there is no reason for the second to differ.
--
-- media_operator            'kie' | 'poyo'. NULL reads as 'kie', which is what
--                           every deployment ran before this column existed.
-- media_operator_per_surface { "<surface>": "kie" | "poyo" }
--                           Surfaces: chat, image, video, tts, transcription.
--                           A missing key inherits the global value, so {} is
--                           exactly the prior behaviour.
--
-- Surfaces rather than the twelve workflow steps because a provider is
-- integrated per surface, not per step: image_gen and thumbnail_image are the
-- same client and the same catalog, and letting an admin split them would offer
-- a choice that means nothing underneath.
--
-- Does NOT govern the free lanes. GenAIPro free video, ai33 and Qwen voices and
-- the BYO Cloudflare image tier keep their own providers whatever this is set
-- to. They run on separate wallets or the customer's own key, so dragging them
-- onto the switched operator would start billing Heclus for work that is
-- currently free. Enforced in lib/operators/routing.ts, which checks the free
-- lane before it reads this column at all.

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS media_operator TEXT,
  ADD COLUMN IF NOT EXISTS media_operator_per_surface JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE product_config DROP CONSTRAINT IF EXISTS product_config_media_operator_check;
ALTER TABLE product_config ADD CONSTRAINT product_config_media_operator_check
  CHECK (media_operator IS NULL OR media_operator IN ('kie', 'poyo'));
