CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  channel_url TEXT,
  channel_name TEXT,
  channel_info JSONB,
  transcripts JSONB,
  current_state INTEGER DEFAULT 1,
  selected_topic TEXT,
  video_ideas JSONB,
  channel_analysis JSONB,
  script TEXT,
  word_count INTEGER,
  target_word_count INTEGER,
  visual_profile JSONB,
  thumbnail_analysis JSONB,
  tts_url TEXT,
  tts_voice_id TEXT,
  tts_model_id TEXT,
  image_model_id TEXT,
  video_model_id TEXT,
  images_progress INTEGER DEFAULT 0,
  videos_progress INTEGER DEFAULT 0
);

CREATE TABLE project_beats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  beat_number INTEGER NOT NULL,
  script_segment TEXT,
  image_prompt TEXT,
  video_prompt TEXT,
  camera TEXT,
  lighting TEXT,
  mood TEXT,
  action TEXT,
  image_url TEXT,
  video_url TEXT,
  image_status TEXT DEFAULT 'pending',
  video_status TEXT DEFAULT 'pending',
  video_job_id TEXT,
  UNIQUE(project_id, beat_number)
);

CREATE TABLE project_thumbnails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  title TEXT,
  visual_concept TEXT,
  text_overlay TEXT,
  emotion_trigger TEXT,
  style_prompt TEXT,
  image_url TEXT,
  image_status TEXT DEFAULT 'pending',
  UNIQUE(project_id, position)
);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Storage bucket setup (run in Supabase dashboard or via CLI):
-- INSERT INTO storage.buckets (id, name, public) VALUES ('assets', 'assets', true);
