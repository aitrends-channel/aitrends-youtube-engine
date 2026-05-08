CREATE TABLE app_settings (
  id                 INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  anthropic_api_key  TEXT,
  youtube_api_key    TEXT,
  kie_api_key        TEXT,
  elevenlabs_api_key TEXT,
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- Seed the singleton row so all future operations are plain UPDATEs
INSERT INTO app_settings (id) VALUES (1);

CREATE TRIGGER app_settings_updated_at
  BEFORE UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
