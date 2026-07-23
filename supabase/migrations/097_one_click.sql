-- 1Click (autopilot) mode: the user kicks off a project and the whole
-- pipeline runs to completion server-side, auto-accepting every wizard
-- gate with the user's saved preferences.
--
-- one_click_configs: per-user preference presets. v1 keeps exactly one
-- row per user (the default preset), but the shape supports multiple
-- named presets later ("run this channel with my Documentary preset")
-- without another migration. The config payload is JSONB (with an
-- internal version field) so preference fields can evolve freely:
--   { version, tts: {modelId, voiceId},
--     output: {aspectRatio, resolution},          -- unified format
--     images: {primary, secondary, fallback},     -- model chain
--     videos: {primary, secondary, fallback},
--     assemble: {bgMusicUrl, bgMusicVolume, captionsEnabled,
--                captionsStyle..., logoUrl, logoX, logoY, logoSize} }
--
-- Access is exclusively through server routes using the service key
-- (same trust model as account_settings) — no RLS needed here.

CREATE TABLE IF NOT EXISTS one_click_configs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- UNIQUE = exactly one preset per user in v1, and it lets the API
  -- upsert ON CONFLICT (user_id). When named presets arrive, drop
  -- this constraint for UNIQUE (user_id, name) + a partial default
  -- index — the table shape itself won't need to change.
  user_id     UUID        NOT NULL UNIQUE,
  name        TEXT        NOT NULL DEFAULT 'Default',
  is_default  BOOLEAN     NOT NULL DEFAULT TRUE,
  config      JSONB       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Autopilot state on the project itself. auto_pilot_config is a
-- SNAPSHOT of the preset taken at kickoff, so edits to the preset
-- never change a run already in flight.
--   auto_pilot_status: running | needs_attention | completed | stopped
--   auto_pilot_attempts: per-step retry/fallback counters, e.g.
--     {"script": 1, "video:beat-3": 2}
ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_pilot           BOOLEAN     NOT NULL DEFAULT FALSE;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_pilot_status    TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_pilot_error     TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_pilot_config    JSONB;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_pilot_attempts  JSONB       NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_pilot_last_tick TIMESTAMPTZ;

-- The tick loop's work-finding query: autopilot projects still running.
CREATE INDEX IF NOT EXISTS idx_projects_auto_pilot_running
  ON projects (auto_pilot_last_tick)
  WHERE auto_pilot AND auto_pilot_status = 'running';
