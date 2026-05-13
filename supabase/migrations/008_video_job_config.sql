-- Store video generation parameters on the project so the worker can read them
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS video_model_id TEXT,
  ADD COLUMN IF NOT EXISTS video_duration TEXT,
  ADD COLUMN IF NOT EXISTS video_aspect_ratio TEXT DEFAULT '16:9';
