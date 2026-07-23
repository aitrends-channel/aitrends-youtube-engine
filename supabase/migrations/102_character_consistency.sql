-- Reusable character-consistency text appended to image prompts.
--
-- Users can define a single free-text statement (e.g. "Recurring
-- character: a 30yo woman, red curly hair, green parka. Keep her face,
-- hairstyle and outfit identical across every image.") that gets
-- APPENDED to each beat's image prompt at generation time. Applied ONLY
-- when a prompt is sent to the image generator — the stored
-- project_beats.image_prompt stays clean and hand-editable.
--
-- Two levels (see lib/character-consistency.ts for the resolution):
--   • account_settings.character_consistency_text — the per-user global
--     default text, used by every project. NOT NULL DEFAULT '' so an
--     unset account simply appends nothing.
--   • projects.character_consistency_text — per-project override text.
--     NULLABLE: NULL = "inherit the account default"; an explicit ''
--     means "no consistency text for this project".
--   • projects.character_consistency_append — the detach/append switch.
--     TRUE (default) appends the text; FALSE detaches it for this
--     project regardless of the text.

ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS character_consistency_text TEXT NOT NULL DEFAULT '';

ALTER TABLE projects ADD COLUMN IF NOT EXISTS character_consistency_text TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS character_consistency_append BOOLEAN NOT NULL DEFAULT TRUE;
