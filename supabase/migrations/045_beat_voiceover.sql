-- Per-beat voiceover support. Each beat gets its own TTS mp3
-- generated independently from its script_segment. The assembler then
-- concatenates the per-beat audio instead of running STT + alignBeats
-- against one big voiceover.
--
-- Why per beat instead of one continuous voiceover:
--   • Drift goes to zero by construction — beat N's visual is locked
--     to beat N's audio file; no matcher needed.
--   • Cheap incremental edits: changing one beat's script regenerates
--     just that beat (saves ElevenLabs cost and wall time).
--   • Failure isolation: a single beat fails → retry just that beat,
--     not the whole voiceover.
--
-- Trade-off (documented for future maintainers): the audio loses the
-- prosodic carry-over between sentences that a continuous render has.
-- For narrative content the difference is audible; for educational /
-- explainer content it's typically not noticed.

ALTER TABLE project_beats ADD COLUMN IF NOT EXISTS voiceover_url TEXT;

-- pending  — row exists, not yet queued
-- queued   — submitted to KIE, awaiting TTS completion
-- done     — voiceover_url populated, ready to use
-- failed   — see voiceover_error
ALTER TABLE project_beats ADD COLUMN IF NOT EXISTS voiceover_status TEXT;

-- Measured from the rendered audio (ffprobe at the worker or response
-- metadata at the engine). Used by the assembler as the beat's clip
-- duration — no STT, no alignment.
ALTER TABLE project_beats ADD COLUMN IF NOT EXISTS voiceover_duration_ms INT;

-- Which voice this beat was generated against. Lets the UI detect
-- "user switched voices on the project — these beats need regen" by
-- comparing against projects.tts_voice_id.
ALTER TABLE project_beats ADD COLUMN IF NOT EXISTS voiceover_voice_id TEXT;

-- Hash of the script_segment used when this voiceover was generated.
-- If script_segment changes (Prompts re-run, user edit), the hash
-- mismatches and the row is flagged stale in the UI.
ALTER TABLE project_beats ADD COLUMN IF NOT EXISTS voiceover_script_hash TEXT;

-- Human-readable failure reason (KIE error, upload failure, etc).
-- Cleared when the row transitions back to queued or done.
ALTER TABLE project_beats ADD COLUMN IF NOT EXISTS voiceover_error TEXT;

-- KIE task id while a TTS job is in flight. Used by any future poll/
-- recovery worker that wants to know which beats have pending KIE
-- jobs without scanning every row.
ALTER TABLE project_beats ADD COLUMN IF NOT EXISTS voiceover_job_id TEXT;
