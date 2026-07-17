-- Bulk-mail send history. One row per bulk send: which audience,
-- which template, what was sent, and to whom — so the admin panel can
-- show a history of every email category sent and warn before
-- re-emailing recently-contacted users (anti-spam guard).
--
-- recipient_emails holds the successfully-delivered addresses; the
-- panel builds an email -> last-contacted map from it to badge matched
-- recipients ("emailed 2d ago"). Individual message copies still live
-- in the emails table (053) — this is the campaign-level record.

CREATE TABLE IF NOT EXISTS bulk_mail_sends (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Audience id: "any", a stuck-at step, or a customer slice.
  phase               TEXT        NOT NULL,
  -- Template selected in the composer at send time (null for a fully
  -- hand-written draft sent before templates existed).
  template_id         TEXT,
  subject             TEXT        NOT NULL,
  body_text           TEXT        NOT NULL,
  include_video_table BOOLEAN     NOT NULL DEFAULT true,
  recipient_emails    TEXT[]      NOT NULL DEFAULT '{}',
  sent_count          INTEGER     NOT NULL DEFAULT 0,
  failed_count        INTEGER     NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bulk_mail_sends_created_at ON bulk_mail_sends (created_at DESC);
