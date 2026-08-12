-- A credit wallet, so Heclus can pay a provider and meter users against it.
--
-- Until now every generation was paid by the user's own key, so Heclus never
-- had to know who owed what: project_costs recorded consumption after the fact
-- and was deliberately fail-soft, because a lost counter must never break a
-- render. That is the right design for a meter and the wrong one for money.
--
-- Two structures, on purpose:
--
--   credit_accounts   one row per user, authoritative for authorisation. The
--                     RPCs below take a row lock on it, which is what stops a
--                     300-beat project from overdrawing when it fires many
--                     submits at once.
--   credit_ledger     append-only audit trail. Every movement, with enough
--                     reference to answer "why is my balance this" months
--                     later. Nothing updates or deletes a row here.
--
-- The account row is not the ledger's cache: it is the authority for spending
-- decisions, and the ledger is the record. They are compared by a reconciler
-- rather than derived from each other, because summing a ledger under a lock on
-- every submit does not hold up at 300 clips a project, and because a wallet
-- whose balance is only ever a SUM() has no place to hold a reservation.
--
-- Two buckets, never mixed:
--
--   grant   the monthly allowance. Expires at period end, which is normal for
--           an allowance and is what makes it affordable to give away.
--   paid    bought with money. Never expires. Expiring credit somebody paid
--           for is a chargeback and a bad review.
--
-- Spending always draws the grant down first, so the bucket that is about to
-- expire is the one that gets used.

CREATE TABLE IF NOT EXISTS credit_accounts (
  user_id          UUID PRIMARY KEY,
  -- Remaining allowance for grant_period. Reset (not topped up) when the
  -- period rolls over, so an unused month never accumulates.
  grant_credits    INTEGER NOT NULL DEFAULT 0,
  grant_period     TEXT,
  -- Bought credit. Survives period rollover, plan change and cancellation.
  paid_credits     INTEGER NOT NULL DEFAULT 0,
  -- Held by open reservations: already committed to an in-flight generation,
  -- not yet debited. Available to spend = grant + paid, both already net of
  -- what reserve_credits moved out, so this column is for display and for
  -- catching leaks rather than for arithmetic.
  reserved_credits INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credit_accounts_non_negative
    CHECK (grant_credits >= 0 AND paid_credits >= 0 AND reserved_credits >= 0)
);

COMMENT ON TABLE credit_accounts IS
  'Authoritative balance per user. Written only by the credit_* functions, which hold a row lock.';

CREATE TABLE IF NOT EXISTS credit_ledger (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL,
  -- monthly_grant  allowance issued for a period
  -- grant_expiry   unused allowance withdrawn at rollover
  -- topup          bought credit
  -- debit          a generation was charged
  -- refund         a charged generation failed, or a reservation was released
  -- adjustment     an admin moved the balance by hand
  kind           TEXT NOT NULL,
  -- Signed, in credits: positive adds, negative removes. Signed rather than a
  -- separate direction column so the reconciler is a single SUM.
  credits        INTEGER NOT NULL,
  bucket         TEXT NOT NULL,
  reservation_id UUID,
  project_id     UUID,
  beat_number    INTEGER,
  provider       TEXT,
  -- The payment or task this row came from. Carries the idempotency for
  -- top-ups: one payment can only ever credit once.
  external_ref   TEXT,
  -- 'YYYY-MM' for grant rows, so re-running a grant is a no-op.
  period         TEXT,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT credit_ledger_kind_check CHECK (kind IN
    ('monthly_grant', 'grant_expiry', 'topup', 'debit', 'refund', 'adjustment')),
  CONSTRAINT credit_ledger_bucket_check CHECK (bucket IN ('grant', 'paid')),
  CONSTRAINT credit_ledger_credits_nonzero CHECK (credits <> 0)
);

COMMENT ON TABLE credit_ledger IS
  'Append-only record of every credit movement. Never updated or deleted.';

-- Idempotency, enforced by the database rather than by careful callers.
-- A grant cron that fires twice, or a payment return that is refreshed, both
-- become no-ops instead of free credit.
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_one_grant_per_period
  ON credit_ledger (user_id, period) WHERE kind = 'monthly_grant';
CREATE UNIQUE INDEX IF NOT EXISTS credit_ledger_one_topup_per_payment
  ON credit_ledger (external_ref) WHERE kind = 'topup' AND external_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS credit_ledger_user_time ON credit_ledger (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS credit_ledger_reservation ON credit_ledger (reservation_id)
  WHERE reservation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS credit_reservations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  credits     INTEGER NOT NULL CHECK (credits > 0),
  -- How the reservation was funded, so releasing it puts the credit back in
  -- the bucket it came from. A grant credit released after rollover is gone,
  -- and that is correct: the allowance it belonged to has expired.
  from_grant  INTEGER NOT NULL DEFAULT 0,
  from_paid   INTEGER NOT NULL DEFAULT 0,
  state       TEXT NOT NULL DEFAULT 'open',
  project_id  UUID,
  beat_number INTEGER,
  provider    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at   TIMESTAMPTZ,
  CONSTRAINT credit_reservations_state_check CHECK (state IN ('open', 'settled', 'released'))
);

-- The sweep that finds reservations whose generation never reported back.
CREATE INDEX IF NOT EXISTS credit_reservations_open
  ON credit_reservations (created_at) WHERE state = 'open';
CREATE INDEX IF NOT EXISTS credit_reservations_beat
  ON credit_reservations (project_id, beat_number) WHERE state = 'open';

-- ── Authorisation and settlement ────────────────────────────────────────────
-- All four run SECURITY DEFINER so the service-role caller is the only route
-- in, and every one that touches a balance locks the account row first.

-- Issue (or roll over) the monthly allowance. Safe to call on every balance
-- read: it does nothing when the period's grant already exists.
CREATE OR REPLACE FUNCTION ensure_monthly_grant(
  p_user UUID, p_credits INTEGER, p_period TEXT
) RETURNS credit_accounts LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  acct credit_accounts;
BEGIN
  INSERT INTO credit_accounts (user_id) VALUES (p_user)
    ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO acct FROM credit_accounts WHERE user_id = p_user FOR UPDATE;

  IF acct.grant_period IS NOT DISTINCT FROM p_period THEN
    RETURN acct;  -- already granted for this period
  END IF;

  -- Withdraw whatever is left of the previous allowance. Recorded rather than
  -- silently dropped, so a customer asking "where did my 40 credits go" gets
  -- an answer with a timestamp.
  IF acct.grant_credits > 0 AND acct.grant_period IS NOT NULL THEN
    INSERT INTO credit_ledger (user_id, kind, credits, bucket, period, note)
    VALUES (p_user, 'grant_expiry', -acct.grant_credits, 'grant', acct.grant_period,
            'Unused allowance withdrawn at period rollover');
  END IF;

  IF p_credits > 0 THEN
    INSERT INTO credit_ledger (user_id, kind, credits, bucket, period, note)
    VALUES (p_user, 'monthly_grant', p_credits, 'grant', p_period, 'Monthly allowance');
  END IF;

  UPDATE credit_accounts
     SET grant_credits = GREATEST(p_credits, 0),
         grant_period  = p_period,
         updated_at    = now()
   WHERE user_id = p_user
   RETURNING * INTO acct;

  RETURN acct;
END;
$$;

-- Hold credit for a generation that is about to be submitted. Returns NULL
-- when the balance will not cover it, which the caller must treat as a refusal
-- rather than a warning: no credit, no generation.
CREATE OR REPLACE FUNCTION reserve_credits(
  p_user UUID, p_credits INTEGER, p_provider TEXT DEFAULT NULL,
  p_project UUID DEFAULT NULL, p_beat INTEGER DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  acct       credit_accounts;
  take_grant INTEGER;
  take_paid  INTEGER;
  res_id     UUID;
BEGIN
  IF p_credits IS NULL OR p_credits <= 0 THEN RETURN NULL; END IF;

  SELECT * INTO acct FROM credit_accounts WHERE user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF acct.grant_credits + acct.paid_credits < p_credits THEN
    RETURN NULL;
  END IF;

  -- Grant first: it is the bucket with an expiry date on it.
  take_grant := LEAST(acct.grant_credits, p_credits);
  take_paid  := p_credits - take_grant;

  INSERT INTO credit_reservations
    (user_id, credits, from_grant, from_paid, provider, project_id, beat_number)
  VALUES (p_user, p_credits, take_grant, take_paid, p_provider, p_project, p_beat)
  RETURNING id INTO res_id;

  UPDATE credit_accounts
     SET grant_credits    = grant_credits - take_grant,
         paid_credits     = paid_credits - take_paid,
         reserved_credits = reserved_credits + p_credits,
         updated_at       = now()
   WHERE user_id = p_user;

  RETURN res_id;
END;
$$;

-- The generation finished. Turn the hold into a debit. p_actual allows a
-- provider that charges by result rather than by request; anything reserved
-- and not spent goes back to the bucket it came from.
CREATE OR REPLACE FUNCTION settle_reservation(
  p_reservation UUID, p_actual INTEGER DEFAULT NULL, p_note TEXT DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  res       credit_reservations;
  actual    INTEGER;
  unspent   INTEGER;
  back_paid INTEGER;
BEGIN
  SELECT * INTO res FROM credit_reservations WHERE id = p_reservation FOR UPDATE;
  IF NOT FOUND OR res.state <> 'open' THEN RETURN FALSE; END IF;

  actual  := LEAST(COALESCE(p_actual, res.credits), res.credits);
  unspent := res.credits - actual;

  PERFORM 1 FROM credit_accounts WHERE user_id = res.user_id FOR UPDATE;

  IF actual > 0 THEN
    INSERT INTO credit_ledger
      (user_id, kind, credits, bucket, reservation_id, project_id, beat_number, provider, note)
    VALUES (res.user_id, 'debit', -actual,
            CASE WHEN res.from_grant >= actual THEN 'grant' ELSE 'paid' END,
            res.id, res.project_id, res.beat_number, res.provider, p_note);
  END IF;

  IF unspent > 0 THEN
    -- Unspent grant credit only returns while its period is still current.
    back_paid := LEAST(unspent, res.from_paid);
    UPDATE credit_accounts
       SET paid_credits  = paid_credits + back_paid,
           grant_credits = grant_credits + (unspent - back_paid),
           updated_at    = now()
     WHERE user_id = res.user_id;
  END IF;

  UPDATE credit_accounts
     SET reserved_credits = GREATEST(reserved_credits - res.credits, 0),
         updated_at       = now()
   WHERE user_id = res.user_id;

  UPDATE credit_reservations
     SET state = 'settled', closed_at = now(), credits = res.credits
   WHERE id = res.id;

  RETURN TRUE;
END;
$$;

-- The generation failed, or never came back. Put the credit back untouched.
-- No debit row is written: nothing was delivered, so nothing was charged.
CREATE OR REPLACE FUNCTION release_reservation(
  p_reservation UUID, p_reason TEXT DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  res credit_reservations;
BEGIN
  SELECT * INTO res FROM credit_reservations WHERE id = p_reservation FOR UPDATE;
  IF NOT FOUND OR res.state <> 'open' THEN RETURN FALSE; END IF;

  PERFORM 1 FROM credit_accounts WHERE user_id = res.user_id FOR UPDATE;

  UPDATE credit_accounts
     SET grant_credits    = grant_credits + res.from_grant,
         paid_credits     = paid_credits + res.from_paid,
         reserved_credits = GREATEST(reserved_credits - res.credits, 0),
         updated_at       = now()
   WHERE user_id = res.user_id;

  INSERT INTO credit_ledger
    (user_id, kind, credits, bucket, reservation_id, project_id, beat_number, provider, note)
  VALUES (res.user_id, 'refund', res.credits,
          CASE WHEN res.from_paid > 0 THEN 'paid' ELSE 'grant' END,
          res.id, res.project_id, res.beat_number, res.provider,
          COALESCE(p_reason, 'Generation did not complete'));

  UPDATE credit_reservations SET state = 'released', closed_at = now() WHERE id = res.id;
  RETURN TRUE;
END;
$$;

-- Bought credit, and admin corrections. Idempotent on external_ref for
-- top-ups, because the payment return can be refreshed.
CREATE OR REPLACE FUNCTION add_credits(
  p_user UUID, p_credits INTEGER, p_kind TEXT,
  p_external_ref TEXT DEFAULT NULL, p_note TEXT DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_kind NOT IN ('topup', 'adjustment') OR p_credits = 0 THEN RETURN FALSE; END IF;

  INSERT INTO credit_accounts (user_id) VALUES (p_user) ON CONFLICT (user_id) DO NOTHING;
  PERFORM 1 FROM credit_accounts WHERE user_id = p_user FOR UPDATE;

  BEGIN
    INSERT INTO credit_ledger (user_id, kind, credits, bucket, external_ref, note)
    VALUES (p_user, p_kind, p_credits, 'paid', p_external_ref, p_note);
  EXCEPTION WHEN unique_violation THEN
    RETURN FALSE;  -- this payment already credited
  END;

  UPDATE credit_accounts
     SET paid_credits = GREATEST(paid_credits + p_credits, 0), updated_at = now()
   WHERE user_id = p_user;

  RETURN TRUE;
END;
$$;

-- Users may read their own balance and history. Every write goes through the
-- functions above on the service role, so no write policy exists at all.
ALTER TABLE credit_accounts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_own_credit_account ON credit_accounts;
CREATE POLICY users_own_credit_account ON credit_accounts
  FOR SELECT USING (auth.uid() = user_id);

ALTER TABLE credit_ledger ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS users_own_credit_ledger ON credit_ledger;
CREATE POLICY users_own_credit_ledger ON credit_ledger
  FOR SELECT USING (auth.uid() = user_id);

-- Reservations are machinery, not history. No policy: service role only.
ALTER TABLE credit_reservations ENABLE ROW LEVEL SECURITY;
