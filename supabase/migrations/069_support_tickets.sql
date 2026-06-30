-- In-app support tickets submitted via the floating HelpButton.
-- Lives in the DB (not the emails table) so the admin panel can
-- triage by status without scrolling through unrelated inbox mail,
-- and so unauthenticated visitors can still file a ticket without
-- triggering an outbound SMTP send.
--
-- user_id is nullable on purpose: the HelpButton renders on every
-- page, including marketing / auth / signup, and a signed-out
-- visitor's submission still needs to land somewhere. When the
-- requester is authenticated, the server overrides the client-typed
-- email with their auth email and writes user_id alongside.
--
-- status drives the admin queue: open → in_progress → resolved →
-- closed. A simple CHECK constraint lists the valid values so a
-- bad value can't slip through; "open" is the default on insert.

CREATE TABLE IF NOT EXISTS support_tickets (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID,
  email         TEXT        NOT NULL,
  subject       TEXT        NOT NULL,
  message       TEXT        NOT NULL,
  -- Fine-grained workflow state for the admin queue. is_open below
  -- mirrors a simple "still needs attention?" boolean so common UI
  -- filters don't have to enumerate status values.
  status        TEXT        NOT NULL DEFAULT 'open',
  is_open       BOOLEAN     NOT NULL DEFAULT true,
  admin_notes   TEXT,
  responded_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT support_tickets_status_check
    CHECK (status IN ('open', 'in_progress', 'resolved', 'closed'))
);

-- Backfill columns onto an already-created table (e.g. a previous
-- partial run of this migration). Each ADD COLUMN is IF NOT EXISTS
-- so re-runs are safe; the defaults take care of pre-existing rows
-- so the NOT NULL constraints don't choke on backfill.
ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS subject TEXT;
ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS is_open BOOLEAN NOT NULL DEFAULT true;

-- Force a sensible value on any existing rows, then promote subject
-- to NOT NULL once everything is populated. Wrapping the SET NOT NULL
-- in a DO block keeps the migration idempotent — once the column is
-- already NOT NULL the second pass is a no-op.
UPDATE support_tickets SET subject = '(no subject)' WHERE subject IS NULL;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'support_tickets'
      AND column_name = 'subject'
      AND is_nullable = 'YES'
  ) THEN
    ALTER TABLE support_tickets ALTER COLUMN subject SET NOT NULL;
  END IF;
END $$;

-- Fast filters for the admin queue ("show me open tickets, newest first")
-- and per-user history ("show this user's prior tickets"). The
-- partial is_open index covers the most common admin query — the
-- triage list of unresolved tickets — without bloating with the
-- closed-ticket archive.
CREATE INDEX IF NOT EXISTS support_tickets_status_created_idx
  ON support_tickets (status, created_at DESC);
CREATE INDEX IF NOT EXISTS support_tickets_is_open_created_idx
  ON support_tickets (created_at DESC)
  WHERE is_open = true;
CREATE INDEX IF NOT EXISTS support_tickets_user_created_idx
  ON support_tickets (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

-- Keep updated_at honest without forcing every route to set it.
CREATE OR REPLACE FUNCTION support_tickets_touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS support_tickets_touch_updated_at_trigger ON support_tickets;
CREATE TRIGGER support_tickets_touch_updated_at_trigger
  BEFORE UPDATE ON support_tickets
  FOR EACH ROW EXECUTE FUNCTION support_tickets_touch_updated_at();
