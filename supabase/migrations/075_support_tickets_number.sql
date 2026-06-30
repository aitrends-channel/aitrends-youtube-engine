-- Human-friendly sequential ticket number for support_tickets,
-- displayed in the admin queue as "HS01", "HS02", … The number is
-- generated from a dedicated sequence so two concurrent inserts
-- never collide on the same value (which a count-based "next
-- number" lookup would risk).
--
-- We store the raw integer here and format the "HS" prefix +
-- zero padding on display — keeps the column type narrow and
-- makes sorting / range filters trivial in SQL.
--
-- Re-run safe: CREATE SEQUENCE / ADD COLUMN / ADD CONSTRAINT all
-- gated on IF NOT EXISTS. Existing rows pick up nextval() values
-- via the DEFAULT, so a partial migration that already added the
-- column but not the unique index will fill in the rest cleanly
-- on a second run.

CREATE SEQUENCE IF NOT EXISTS support_tickets_ticket_number_seq;

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS ticket_number INTEGER
    NOT NULL DEFAULT nextval('support_tickets_ticket_number_seq');

-- Tie the sequence's lifecycle to the column so dropping the column
-- (or table) also drops the sequence. No-op if already owned.
ALTER SEQUENCE support_tickets_ticket_number_seq
  OWNED BY support_tickets.ticket_number;

-- Guarantee uniqueness so the human-facing reference is stable.
CREATE UNIQUE INDEX IF NOT EXISTS support_tickets_ticket_number_idx
  ON support_tickets (ticket_number);
