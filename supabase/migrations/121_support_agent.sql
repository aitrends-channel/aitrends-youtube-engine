-- Support agent: in-app chat, and an auto-reply backstop for tickets nobody
-- has answered.
--
-- Two surfaces, one agent. Chat is interactive — the user reads the answer
-- immediately and can push back — so it carries little risk. The auto-reply
-- sends unreviewed model output to a paying customer with nobody watching,
-- which is a different thing entirely, so it ships off, and even once enabled
-- it starts in a dry-run mode that records what it would have sent.
--
-- Config lives on product_config.support_agent so both can be turned off from
-- the admin dashboard without a deploy. That matters more than usual here: the
-- failure mode of a bad auto-reply is a wrong answer already in a customer's
-- inbox, and the fix has to be one toggle away.

CREATE TABLE IF NOT EXISTS support_chats (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID        REFERENCES auth.users(id) ON DELETE CASCADE,
  email               TEXT        NOT NULL,
  -- open: the user is still talking. escalated: a ticket was raised from it.
  -- closed: resolved, or abandoned.
  status              TEXT        NOT NULL DEFAULT 'open',
  -- Set when the agent (or the user) hands off to a person.
  escalated_ticket_id UUID        REFERENCES support_tickets(id) ON DELETE SET NULL,
  -- A ticket the agent has drafted and the user has not yet approved.
  -- {subject, message}. Held server-side rather than round-tripped through the
  -- client so the text that was previewed is the text that gets filed.
  pending_ticket      JSONB,
  -- Set when the user aborts a drafted ticket; suppresses further offers.
  ticket_declined_at  TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE support_chats
  ADD COLUMN IF NOT EXISTS pending_ticket JSONB,
  -- Set when the user throws a drafted ticket away. The agent stops offering
  -- one after that: re-proposing what somebody just declined is nagging, and
  -- it is the fastest way to make a helpful widget feel pushy.
  ADD COLUMN IF NOT EXISTS ticket_declined_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS support_chats_user_idx ON support_chats (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS support_chats_status_idx ON support_chats (status, created_at DESC);

CREATE TABLE IF NOT EXISTS support_chat_messages (
  id         BIGSERIAL   PRIMARY KEY,
  chat_id    UUID        NOT NULL REFERENCES support_chats(id) ON DELETE CASCADE,
  -- 'user' | 'agent' | 'system' (system = handoff notices and the like)
  role       TEXT        NOT NULL,
  content    TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_chat_messages_chat_idx ON support_chat_messages (chat_id, created_at);

-- Users read their own chats; everything is written server-side with the
-- service role, so no insert/update policy is needed.
ALTER TABLE support_chats ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_own_support_chats ON support_chats;
CREATE POLICY users_own_support_chats ON support_chats
  FOR SELECT USING (auth.uid() = user_id);

ALTER TABLE support_chat_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_own_support_chat_messages ON support_chat_messages;
CREATE POLICY users_own_support_chat_messages ON support_chat_messages
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM support_chats c WHERE c.id = chat_id AND c.user_id = auth.uid())
  );

-- Auto-reply bookkeeping on the ticket itself, so the worker is idempotent
-- without a second table. auto_replied_at is the guard: one automated reply per
-- ticket, ever. A draft with no timestamp is a dry-run record of what the
-- worker would have sent.
ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS auto_replied_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_reply_draft  TEXT,
  ADD COLUMN IF NOT EXISTS auto_reply_note   TEXT,
  -- Chat-raised tickets carry their transcript, so an admin picking one up
  -- reads what the user already tried instead of asking again.
  ADD COLUMN IF NOT EXISTS chat_id           UUID REFERENCES support_chats(id) ON DELETE SET NULL;

COMMENT ON COLUMN support_tickets.auto_replied_at IS
  'Set once an automated reply has been SENT. Non-null means the worker will never touch this ticket again.';
COMMENT ON COLUMN support_tickets.auto_reply_draft IS
  'What the auto-reply worker produced. Populated in dry-run mode without sending, and kept after a real send as a record.';
COMMENT ON COLUMN support_tickets.auto_reply_note IS
  'Why the worker skipped or held this ticket (needs a person, no cause found, agent disabled).';

-- Index the worker's own query: open tickets, oldest first, never auto-replied.
CREATE INDEX IF NOT EXISTS support_tickets_auto_reply_idx
  ON support_tickets (created_at)
  WHERE is_open = true AND auto_replied_at IS NULL;

-- Config. Off by default, dry-run first once enabled: shipping this any other
-- way would mean the first anyone hears of a bad answer is a customer reading
-- it. delay_minutes is how long an admin gets before the worker steps in.
ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS support_agent JSONB;

UPDATE product_config
SET support_agent = '{
  "chat_enabled": true,
  "auto_reply_enabled": false,
  "auto_reply_dry_run": true,
  "auto_reply_delay_minutes": 10,
  "auto_reply_max_per_run": 5
}'::jsonb
WHERE service = '_global' AND support_agent IS NULL;

COMMENT ON COLUMN product_config.support_agent IS
  'Support agent switches. chat_enabled gates the in-app chat. auto_reply_enabled gates the ticket backstop; while auto_reply_dry_run is true it only records drafts. auto_reply_delay_minutes is the grace period an admin gets first.';
