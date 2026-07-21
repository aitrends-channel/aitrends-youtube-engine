-- Remove the earlier prefix/suffix design in favour of the single
-- appended character-consistency text (see 102_character_consistency.sql).
--
-- Idempotent and self-contained: safe whether or not the earlier
-- prefix/suffix variant of 102 was applied. Also (re)asserts the
-- character-consistency columns so a database that only ever got the
-- prefix/suffix columns ends up in the correct final state.

ALTER TABLE account_settings DROP COLUMN IF EXISTS image_prompt_prefix;
ALTER TABLE account_settings DROP COLUMN IF EXISTS image_prompt_suffix;
ALTER TABLE projects DROP COLUMN IF EXISTS image_prompt_prefix;
ALTER TABLE projects DROP COLUMN IF EXISTS image_prompt_suffix;

ALTER TABLE account_settings ADD COLUMN IF NOT EXISTS character_consistency_text TEXT NOT NULL DEFAULT '';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS character_consistency_text TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS character_consistency_append BOOLEAN NOT NULL DEFAULT TRUE;
