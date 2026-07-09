-- Per-project image-prompt style variant.
--
-- Adds a "Cinematic" mode that layers filmic cues (letterbox, film
-- grain, dramatic lighting, cinematic composition) on top of the
-- extracted visual profile at prompt-generation time. Selection is
-- persisted per project so a page reload doesn't reset it — the
-- Prompts step's tab bar reads/writes this column.
--
-- Values: 'general' | 'cinematic'. NULL is treated as 'general'
-- (pre-migration rows, and any future style unknown to the client).

ALTER TABLE projects ADD COLUMN IF NOT EXISTS prompt_style TEXT;
