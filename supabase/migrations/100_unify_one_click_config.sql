-- Unify the 1Click preset into account_settings. Previously it lived in a
-- separate one_click_configs table (migration 097); now it's a JSONB column
-- on account_settings alongside the user's other settings (api keys,
-- niches_used, assembly_defaults). One row per user, keyed by user_id.

ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS one_click_config JSONB;

-- Migrate existing presets. Users who have a preset but no account_settings
-- row yet get one created (niches_used defaults to 0).
INSERT INTO account_settings (user_id, one_click_config)
SELECT user_id, config
FROM one_click_configs
WHERE is_default = TRUE
ON CONFLICT (user_id) DO UPDATE SET one_click_config = EXCLUDED.one_click_config;

-- The old one_click_configs table is dropped separately in migration 101,
-- after this data migration has been verified.
