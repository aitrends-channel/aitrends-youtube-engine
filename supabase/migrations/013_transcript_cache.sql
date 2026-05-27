CREATE TABLE transcript_cache (
  video_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  text TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  cached_at TIMESTAMPTZ DEFAULT NOW()
);
