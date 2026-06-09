-- Persisted per-beat narration timings.
--
-- The assembler runs ElevenLabs STT and the predictive matcher on
-- every assembly today. With these columns the assembler stores its
-- results the first time and skips both passes on subsequent
-- assemblies — saving 5-15s per reassemble and the ElevenLabs cost
-- when the same project is re-encoded (e.g. captions tweak, aspect
-- ratio change, voiceover trim).
--
-- Invalidation is automatic: a regenerated voiceover or regenerated
-- prompts wipes the beats they refer to (the prompts step deletes
-- project_beats on script change; voiceover regen leaves duration_ms
-- pointing at the *new* audio, but the next assembly's clip-encode
-- step uses the durations directly so the worst case is a misaligned
-- clip the user spots in the preview). For stronger safety, the
-- assembler also compares the voiceover hash on each run and forces
-- a re-measure when it changes.
ALTER TABLE project_beats ADD COLUMN IF NOT EXISTS start_time_ms INT;
ALTER TABLE project_beats ADD COLUMN IF NOT EXISTS end_time_ms INT;
ALTER TABLE project_beats ADD COLUMN IF NOT EXISTS duration_ms INT;

-- Voiceover hash that the saved timings were measured against. When
-- the assembler downloads the current voiceover and the hash differs,
-- the cached timings are discarded so a fresh STT/match pass runs.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS beat_timings_voiceover_hash TEXT;
