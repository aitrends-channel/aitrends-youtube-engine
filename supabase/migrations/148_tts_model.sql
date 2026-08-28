-- Which ElevenLabs model a project's voiceover is spoken on.
--
-- Every voiceover ran on eleven_turbo_v2_5, chosen when it was the only option
-- worth having. It is not the only reasonable one: Multilingual v2 holds up
-- better across accents and non-English, v3 is more expressive, and both bill
-- at twice the rate. That is a trade the person making the video should get to
-- make per project rather than one hardcoded for everybody.
--
-- Nullable, and NULL means the default. Filtered against the catalog on read,
-- so a model retired from the code falls back rather than reaching ElevenLabs.
-- Nothing changes for an existing project on deploy.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS tts_model TEXT;

COMMENT ON COLUMN projects.tts_model IS
  'ElevenLabs model id for this project''s voiceover. NULL uses the default (eleven_turbo_v2_5). Only applies to ElevenLabs voices; Qwen and ai33 voices are separate providers.';
