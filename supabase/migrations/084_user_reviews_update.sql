-- Users can now edit their review from the Account page, so the
-- one-shot INSERT model from migration 083 gains an UPDATE path.
-- updated_at tracks the last edit for the admin panel.

ALTER TABLE user_reviews
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

CREATE POLICY "user_reviews_self_update" ON user_reviews
  FOR UPDATE USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
