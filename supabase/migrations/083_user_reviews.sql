-- One-time NPS-style feedback capture. Row presence = the user has been
-- prompted and responded (either submitted a rating or dismissed the
-- modal), so we never re-prompt the same user.
--
-- rating is nullable so a dismissal can be persisted with no score.
-- review_text is optional even when rating is present.

CREATE TABLE IF NOT EXISTS user_reviews (
  user_id      UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  rating       SMALLINT CHECK (rating IS NULL OR (rating BETWEEN 1 AND 5)),
  review_text  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS user_reviews_created_at_idx
  ON user_reviews (created_at DESC);

ALTER TABLE user_reviews ENABLE ROW LEVEL SECURITY;

-- Users can see their own row (so the client can check "did I respond?")
CREATE POLICY "user_reviews_self_select" ON user_reviews
  FOR SELECT USING (auth.uid() = user_id);

-- Users can insert their own row exactly once — the PRIMARY KEY on
-- user_id enforces the "once" without needing an extra policy check.
CREATE POLICY "user_reviews_self_insert" ON user_reviews
  FOR INSERT WITH CHECK (auth.uid() = user_id);
