-- Admin email feature: a single shared mailbox (support@heclus.com)
-- with one or more aliases (info@heclus.com, etc.) all backed by the
-- same Hostinger IMAP/SMTP account. Inbound mail is pulled via IMAP
-- and persisted here so the dashboard renders fast and survives
-- network blips; outbound mail is sent via SMTP and a copy is
-- written here so the same UI shows it next to inbox messages.

CREATE TABLE IF NOT EXISTS emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- inbound = arrived via IMAP poll; outbound = sent by us via SMTP.
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),

  -- RFC 5322 Message-ID. Unique per message; we de-dup IMAP polls
  -- on this. Outbound rows get the Message-ID nodemailer assigned.
  message_id TEXT NOT NULL UNIQUE,

  -- Threading via the In-Reply-To header (and the first id from
  -- References if In-Reply-To is missing). thread_root_id is the
  -- earliest known ancestor in the conversation — derived in code
  -- when we ingest, never updated after. Lets the UI group a thread
  -- with one indexed lookup instead of walking parent chains.
  in_reply_to TEXT,
  thread_root_id TEXT,

  -- Headers we want to display + search on. Body parsing keeps both
  -- text/plain and text/html variants when both are present. Most
  -- clients send multipart/alternative so we usually have both.
  from_address TEXT NOT NULL,
  to_addresses TEXT[] NOT NULL DEFAULT '{}',
  cc_addresses TEXT[] NOT NULL DEFAULT '{}',
  subject TEXT,
  body_text TEXT,
  body_html TEXT,

  -- received_at: Date header from the message (sender's clock).
  -- sent_at: when SMTP accepted our outbound (our clock).
  received_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,

  -- Mark-as-read for inbound rows. Outbound rows are implicitly read
  -- (we just wrote them) — we keep the column false for them so a
  -- simple is_read = false query never surfaces our own sent mail.
  is_read BOOLEAN NOT NULL DEFAULT FALSE,

  -- Full raw headers as JSON for debugging deliverability / spam
  -- header issues. Optional — we don't display this in the UI.
  raw_headers JSONB,

  -- IMAP de-dup secondary key. UIDVALIDITY is a per-mailbox counter
  -- that changes when the server remaps UIDs (mailbox rebuild,
  -- format change). If it changes, our last-seen-uid cursor is
  -- worthless and we re-sync from scratch — message_id de-dup
  -- catches anything we already had so we don't double-insert.
  imap_uid_validity BIGINT,
  imap_uid BIGINT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- List inbox / sent newest-first. The most common query.
CREATE INDEX IF NOT EXISTS idx_emails_direction_received
  ON emails (direction, received_at DESC NULLS LAST);

-- Thread grouping for the conversation view.
CREATE INDEX IF NOT EXISTS idx_emails_thread_root
  ON emails (thread_root_id)
  WHERE thread_root_id IS NOT NULL;

-- Unread badge query — count inbound + is_read=false.
CREATE INDEX IF NOT EXISTS idx_emails_unread_inbound
  ON emails (received_at DESC)
  WHERE direction = 'inbound' AND is_read = FALSE;

-- IMAP sync cursor. Persisted on product_config (service='_global')
-- so the sync picks up where the previous poll stopped. UIDVALIDITY
-- changes on Hostinger's side (mailbox rebuild) reset the cursor;
-- the emails.message_id unique constraint absorbs duplicates from
-- the re-sync that follows.
ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS imap_uid_validity BIGINT,
  ADD COLUMN IF NOT EXISTS imap_last_uid BIGINT;
