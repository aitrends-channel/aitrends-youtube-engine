-- Voices a user cloned on one of Heclus's own provider accounts.
--
-- The clone physically belongs to Heclus (one shared account and token per
-- provider), so ownership only exists here: every read is scoped to the
-- creating user, and a voice is never listed to anyone else even though
-- the upstream account can see all of them.
--
-- Synthesis needs no new routing — an ai33 clone id already carries the
-- "ai33/" prefix, which routes to Heclus's ai33 token. What it does need
-- is an ownership check, since any user could otherwise pass another
-- user's clone id (see lib/cloned-voices.ts).
--
-- UNIQUE(provider, provider_voice_id) so a retried clone request can't
-- produce two rows for one upstream voice. Deleting the row is the signal
-- to release the upstream slot, a scarce resource shared by all users.

-- sample_url is the clip the clone was made from, kept so the picker can
-- preview the voice: ai33 returns no preview for clones, and synthesizing
-- one on demand would spend the user's character quota on a play button.
CREATE TABLE IF NOT EXISTS cloned_voices (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider          TEXT        NOT NULL,
  provider_voice_id TEXT        NOT NULL,
  name              TEXT        NOT NULL,
  sample_url        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_voice_id)
);

CREATE INDEX IF NOT EXISTS idx_cloned_voices_user_id ON cloned_voices (user_id);

ALTER TABLE cloned_voices ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_own_cloned_voices ON cloned_voices;
CREATE POLICY users_own_cloned_voices ON cloned_voices
  FOR SELECT USING (auth.uid() = user_id);
