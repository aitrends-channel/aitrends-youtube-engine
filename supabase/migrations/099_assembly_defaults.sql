-- Per-user "Use this always" assembly defaults (background music + logo).
-- Saved from the Assemble step so subsequent videos prefill these without
-- the user re-selecting. Shape:
--   { enabled, backgroundMusicUrl, backgroundMusicVolume,
--     logoUrl, logoX, logoY, logoSize }
ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS assembly_defaults JSONB;
