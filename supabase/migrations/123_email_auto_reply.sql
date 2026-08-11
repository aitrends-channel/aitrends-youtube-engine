-- Let the support agent work the shared inbox, not just tickets.
--
-- A ticket carries its own state (status, responded_at), so "nobody has dealt
-- with this" is a column read. An email carried none: answered and unanswered
-- looked identical, and the only way to tell them apart was to walk the thread
-- and look for an outbound message referencing it. That is a query nobody wants
-- to run on every sweep, and it silently gets the answer wrong whenever a mail
-- client rewrites the References header.
--
-- So the fact is recorded when it happens instead. lib/email/smtp.ts stamps the
-- parent inbound row every time a reply goes out, whoever sent it, because every
-- reply passes through that one function.

ALTER TABLE emails
  -- The inbox's own state: has anyone answered this, by any route.
  ADD COLUMN IF NOT EXISTS is_replied      BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS replied_at      TIMESTAMPTZ,
  -- Set only when the agent sends. Separate from replied_at so "a person
  -- answered this" and "a machine answered this" never blur together.
  ADD COLUMN IF NOT EXISTS auto_replied_at TIMESTAMPTZ,
  -- What it said, or would have said in dry run. Kept whether or not it sent.
  ADD COLUMN IF NOT EXISTS auto_reply_draft TEXT,
  -- Why it did what it did, including every reason it declined.
  ADD COLUMN IF NOT EXISTS auto_reply_note  TEXT;

-- Backfill from the threading we can still see, so switching this on does not
-- treat a year of already-answered mail as a backlog to work through. An
-- outbound message quoting an inbound message_id in either In-Reply-To or the
-- thread root is a reply to it.
UPDATE emails inbound
SET is_replied = true,
    replied_at = (
      SELECT min(o.sent_at) FROM emails o
      WHERE o.direction = 'outbound'
        AND (o.in_reply_to = inbound.message_id OR o.thread_root_id = inbound.message_id)
    )
WHERE inbound.direction = 'inbound'
  AND inbound.is_replied = false
  AND EXISTS (
    SELECT 1 FROM emails o
    WHERE o.direction = 'outbound'
      AND (o.in_reply_to = inbound.message_id OR o.thread_root_id = inbound.message_id)
  );

-- The sweep's query: unanswered inbound, oldest first.
CREATE INDEX IF NOT EXISTS idx_emails_unreplied_inbound
  ON emails (received_at)
  WHERE direction = 'inbound' AND is_replied = false;

COMMENT ON COLUMN emails.is_replied IS
  'Someone answered this inbound message. Stamped by lib/email/smtp.ts on any reply carrying In-Reply-To.';
