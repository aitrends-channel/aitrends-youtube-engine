-- Per-user, per-day counter for the BYO free tiers, so the "Free" tab can
-- show a daily usage/progress bar. We track our own count (Cloudflare
-- doesn't expose a usable live Neuron feed to a Workers-AI-scoped token).
--
-- One row per (user, day, kind). kind = 'image' today; room for 'tts_chars'
-- later. Written server-side with the service-role client, so RLS just
-- guards any direct client read.

CREATE TABLE IF NOT EXISTS free_usage (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day     DATE NOT NULL DEFAULT CURRENT_DATE,
  kind    TEXT NOT NULL,
  count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day, kind)
);

ALTER TABLE free_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_own_free_usage ON free_usage;
CREATE POLICY users_own_free_usage ON free_usage
  FOR SELECT USING (auth.uid() = user_id);

-- Atomic increment so batch generations (many beats at once) don't lose
-- counts to read-modify-write races.
CREATE OR REPLACE FUNCTION increment_free_usage(p_user UUID, p_kind TEXT, p_amount INTEGER)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO free_usage (user_id, day, kind, count)
  VALUES (p_user, CURRENT_DATE, p_kind, p_amount)
  ON CONFLICT (user_id, day, kind)
  DO UPDATE SET count = free_usage.count + EXCLUDED.count;
$$;
