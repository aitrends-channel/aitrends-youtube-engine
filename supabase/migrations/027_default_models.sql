-- Admin-configurable default image + video models. Stored on the
-- product_config._global singleton row alongside the existing global
-- settings (founders_promo_limit etc.). When set, /api/kie/models
-- promotes that model id to index 0 so the generate page's "first
-- entry as default" auto-pick lands on the admin's choice.

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS default_image_model TEXT,
  ADD COLUMN IF NOT EXISTS default_video_model TEXT;
