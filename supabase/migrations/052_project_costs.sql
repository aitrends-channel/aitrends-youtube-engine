-- Per-project, per-step usage ledger for cost reporting.
--
-- One row per upstream API call that consumed measurable units. We
-- log the natural unit each provider returns (not converted to USD)
-- so the admin dashboard can show real spend per step without us
-- having to maintain a credit→USD rate table that drifts on every
-- plan change.
--
-- Examples of rows produced by a single 100-beat captioned project:
--   • channel_analysis · anthropic · claude-opus-4-7  ·   8400 · claude_tokens_in
--   • channel_analysis · anthropic · claude-opus-4-7  ·   3100 · claude_tokens_out
--   • channel_analysis · supadata  · supadata         ·      8 · supadata_transcripts
--   • prompts_image    · anthropic · claude-opus-4-7  ·  42000 · claude_tokens_in
--   • prompts_image    · anthropic · claude-opus-4-7  ·   7300 · claude_tokens_out
--   • tts              · kie       · elevenlabs/...   ·    600 · kie_credits
--   • image_gen        · kie       · grok-imagine/... ·    400 · kie_credits
--   • video_gen        · kie       · grok-imagine/... ·    960 · kie_credits  (note: NUMERIC — 9.6 cr per 6s clip)
--   • assemble         · elevenlabs· scribe-stt       ·  12400 · elevenlabs_chars
--
-- units is NUMERIC because KIE returns fractional credits (e.g. 9.6
-- for a 6-second video clip). Claude tokens are integers in practice
-- but NUMERIC handles both shapes without casting drama.
--
-- Per-beat step values (image_gen, video_gen, tts) are aggregated by
-- step in the admin UI; the dashboard's Cost table groups multiple
-- rows under one display column ("Generate" = image_gen + video_gen).
--
-- Indexed on project_id so the admin per-project lookup is O(rows
-- for one project). created_at left out of the index — the admin
-- queries always scope by project_id first, then aggregate.

CREATE TABLE IF NOT EXISTS project_costs (
  id          BIGSERIAL PRIMARY KEY,
  project_id  UUID        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL,
  step        TEXT        NOT NULL,
  provider    TEXT        NOT NULL,
  model       TEXT,
  units       NUMERIC     NOT NULL,
  unit_kind   TEXT        NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_project_costs_project_id
  ON project_costs (project_id);
