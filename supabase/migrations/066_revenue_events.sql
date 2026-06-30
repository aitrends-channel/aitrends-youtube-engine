-- Immutable revenue ledger. Decouples historical revenue from the
-- mutable auth.users / app_metadata source of truth so deleting a
-- user (GDPR, refund + close, launch cleanup, etc.) does not erase
-- their historical contribution to revenue stats.
--
-- Written from the Dodo webhook handler on every payment.succeeded
-- event. user_id is intentionally NOT a foreign key — when an
-- auth.users row is deleted, the revenue_events row stays as an
-- orphan with the original UUID + denormalized email, so analytics
-- can still surface "how much did we earn last quarter."
--
-- dodo_payment_id is UNIQUE so webhook replays (Dodo retries failed
-- deliveries) don't double-count revenue. The INSERT in the handler
-- uses ON CONFLICT DO NOTHING.

CREATE TABLE IF NOT EXISTS revenue_events (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID,
  user_email      TEXT,
  event_type      TEXT         NOT NULL,
  amount_cents    INTEGER      NOT NULL,
  currency        TEXT         NOT NULL DEFAULT 'usd',
  plan            TEXT,
  dodo_payment_id TEXT         UNIQUE,
  dodo_raw        JSONB,
  occurred_at     TIMESTAMPTZ  NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_revenue_events_occurred_at ON revenue_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_revenue_events_user_id     ON revenue_events (user_id);
CREATE INDEX IF NOT EXISTS idx_revenue_events_event_type  ON revenue_events (event_type);
