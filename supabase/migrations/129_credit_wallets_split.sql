-- Two wallets, named for what they are.
--
-- The wallet built in migration 125 was the only one, so it took the general
-- names: credit_accounts, credit_ledger, credit_reservations. It is not general.
-- It exists to spend a monthly perk of free GenAI video clips, counted in whole
-- clips, with a grant bucket that expires on the 1st.
--
-- This migration gives it the name it earned, genai_credits, and hands the
-- general names to the wallet that is actually general: Heclus Credits, bought
-- from us and spent on any work running on Heclus's own provider accounts.
--
-- ORDER OF OPERATIONS MATTERS HERE, and so does the deploy.
--
-- The rename happens first, then the new tables take the freed names. Doing it
-- the other way round collides. And plpgsql resolves table names at execution,
-- not at definition, so the five functions from 125 would break the moment their
-- tables moved: each is recreated against the new name and the old name dropped,
-- rather than left to fail at the first spend.
--
-- The old function names are DROPPED on purpose. If code still calling
-- reserve_credits reached a NUMERIC general-wallet function of the same name, it
-- would quietly spend the wrong balance. Dropped, it fails instead, which is the
-- correct outcome for money: this migration and its deploy must land together,
-- and if they do not, both orders fail closed rather than mis-charging anyone.

-- ---------------------------------------------------------------------------
-- 1. The free GenAI video wallet becomes genai_credits
-- ---------------------------------------------------------------------------

ALTER TABLE IF EXISTS credit_accounts     RENAME TO genai_credits;
ALTER TABLE IF EXISTS credit_ledger       RENAME TO genai_credits_ledger;
ALTER TABLE IF EXISTS credit_reservations RENAME TO genai_credits_reservations;

-- Its functions, recreated verbatim against the renamed tables. Generated from
-- migration 125 rather than retyped, so the bodies cannot drift.

CREATE OR REPLACE FUNCTION genai_credits_ensure_grant(
  p_user UUID, p_credits INTEGER, p_period TEXT
) RETURNS genai_credits LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  acct genai_credits;
BEGIN
  INSERT INTO genai_credits (user_id) VALUES (p_user)
    ON CONFLICT (user_id) DO NOTHING;

  SELECT * INTO acct FROM genai_credits WHERE user_id = p_user FOR UPDATE;

  IF acct.grant_period IS NOT DISTINCT FROM p_period THEN
    RETURN acct;  -- already granted for this period
  END IF;

  -- Withdraw whatever is left of the previous allowance. Recorded rather than
  -- silently dropped, so a customer asking "where did my 40 credits go" gets
  -- an answer with a timestamp.
  IF acct.grant_credits > 0 AND acct.grant_period IS NOT NULL THEN
    INSERT INTO genai_credits_ledger (user_id, kind, credits, bucket, period, note)
    VALUES (p_user, 'grant_expiry', -acct.grant_credits, 'grant', acct.grant_period,
            'Unused allowance withdrawn at period rollover');
  END IF;

  IF p_credits > 0 THEN
    INSERT INTO genai_credits_ledger (user_id, kind, credits, bucket, period, note)
    VALUES (p_user, 'monthly_grant', p_credits, 'grant', p_period, 'Monthly allowance');
  END IF;

  UPDATE genai_credits
     SET grant_credits = GREATEST(p_credits, 0),
         grant_period  = p_period,
         updated_at    = now()
   WHERE user_id = p_user
   RETURNING * INTO acct;

  RETURN acct;
END;
$$;

CREATE OR REPLACE FUNCTION genai_credits_reserve(
  p_user UUID, p_credits INTEGER, p_provider TEXT DEFAULT NULL,
  p_project UUID DEFAULT NULL, p_beat INTEGER DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  acct       genai_credits;
  take_grant INTEGER;
  take_paid  INTEGER;
  res_id     UUID;
BEGIN
  IF p_credits IS NULL OR p_credits <= 0 THEN RETURN NULL; END IF;

  SELECT * INTO acct FROM genai_credits WHERE user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;

  IF acct.grant_credits + acct.paid_credits < p_credits THEN
    RETURN NULL;
  END IF;

  -- Grant first: it is the bucket with an expiry date on it.
  take_grant := LEAST(acct.grant_credits, p_credits);
  take_paid  := p_credits - take_grant;

  INSERT INTO genai_credits_reservations
    (user_id, credits, from_grant, from_paid, provider, project_id, beat_number)
  VALUES (p_user, p_credits, take_grant, take_paid, p_provider, p_project, p_beat)
  RETURNING id INTO res_id;

  UPDATE genai_credits
     SET grant_credits    = grant_credits - take_grant,
         paid_credits     = paid_credits - take_paid,
         reserved_credits = reserved_credits + p_credits,
         updated_at       = now()
   WHERE user_id = p_user;

  RETURN res_id;
END;
$$;

CREATE OR REPLACE FUNCTION genai_credits_settle(
  p_reservation UUID, p_actual INTEGER DEFAULT NULL, p_note TEXT DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  res       genai_credits_reservations;
  actual    INTEGER;
  unspent   INTEGER;
  back_paid INTEGER;
BEGIN
  SELECT * INTO res FROM genai_credits_reservations WHERE id = p_reservation FOR UPDATE;
  IF NOT FOUND OR res.state <> 'open' THEN RETURN FALSE; END IF;

  actual  := LEAST(COALESCE(p_actual, res.credits), res.credits);
  unspent := res.credits - actual;

  PERFORM 1 FROM genai_credits WHERE user_id = res.user_id FOR UPDATE;

  IF actual > 0 THEN
    INSERT INTO genai_credits_ledger
      (user_id, kind, credits, bucket, reservation_id, project_id, beat_number, provider, note)
    VALUES (res.user_id, 'debit', -actual,
            CASE WHEN res.from_grant >= actual THEN 'grant' ELSE 'paid' END,
            res.id, res.project_id, res.beat_number, res.provider, p_note);
  END IF;

  IF unspent > 0 THEN
    -- Unspent grant credit only returns while its period is still current.
    back_paid := LEAST(unspent, res.from_paid);
    UPDATE genai_credits
       SET paid_credits  = paid_credits + back_paid,
           grant_credits = grant_credits + (unspent - back_paid),
           updated_at    = now()
     WHERE user_id = res.user_id;
  END IF;

  UPDATE genai_credits
     SET reserved_credits = GREATEST(reserved_credits - res.credits, 0),
         updated_at       = now()
   WHERE user_id = res.user_id;

  UPDATE genai_credits_reservations
     SET state = 'settled', closed_at = now(), credits = res.credits
   WHERE id = res.id;

  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION genai_credits_release(
  p_reservation UUID, p_reason TEXT DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  res genai_credits_reservations;
BEGIN
  SELECT * INTO res FROM genai_credits_reservations WHERE id = p_reservation FOR UPDATE;
  IF NOT FOUND OR res.state <> 'open' THEN RETURN FALSE; END IF;

  PERFORM 1 FROM genai_credits WHERE user_id = res.user_id FOR UPDATE;

  UPDATE genai_credits
     SET grant_credits    = grant_credits + res.from_grant,
         paid_credits     = paid_credits + res.from_paid,
         reserved_credits = GREATEST(reserved_credits - res.credits, 0),
         updated_at       = now()
   WHERE user_id = res.user_id;

  INSERT INTO genai_credits_ledger
    (user_id, kind, credits, bucket, reservation_id, project_id, beat_number, provider, note)
  VALUES (res.user_id, 'refund', res.credits,
          CASE WHEN res.from_paid > 0 THEN 'paid' ELSE 'grant' END,
          res.id, res.project_id, res.beat_number, res.provider,
          COALESCE(p_reason, 'Generation did not complete'));

  UPDATE genai_credits_reservations SET state = 'released', closed_at = now() WHERE id = res.id;
  RETURN TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION genai_credits_add(
  p_user UUID, p_credits INTEGER, p_kind TEXT,
  p_external_ref TEXT DEFAULT NULL, p_note TEXT DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_kind NOT IN ('topup', 'adjustment') OR p_credits = 0 THEN RETURN FALSE; END IF;

  INSERT INTO genai_credits (user_id) VALUES (p_user) ON CONFLICT (user_id) DO NOTHING;
  PERFORM 1 FROM genai_credits WHERE user_id = p_user FOR UPDATE;

  BEGIN
    INSERT INTO genai_credits_ledger (user_id, kind, credits, bucket, external_ref, note)
    VALUES (p_user, p_kind, p_credits, 'paid', p_external_ref, p_note);
  EXCEPTION WHEN unique_violation THEN
    RETURN FALSE;  -- this payment already credited
  END;

  UPDATE genai_credits
     SET paid_credits = GREATEST(paid_credits + p_credits, 0), updated_at = now()
   WHERE user_id = p_user;

  RETURN TRUE;
END;
$$;

DROP FUNCTION IF EXISTS ensure_monthly_grant(UUID, INTEGER, TEXT);
DROP FUNCTION IF EXISTS reserve_credits(UUID, INTEGER, TEXT, UUID, INTEGER);
DROP FUNCTION IF EXISTS settle_reservation(UUID, INTEGER, TEXT);
DROP FUNCTION IF EXISTS release_reservation(UUID, TEXT);
DROP FUNCTION IF EXISTS add_credits(UUID, INTEGER, TEXT, TEXT, TEXT);

COMMENT ON TABLE genai_credits IS
  'The free GenAI video wallet: a monthly grant of whole video clips, plus any clip credits bought. Was credit_accounts before migration 129. Not the general balance — that is credit_accounts now.';

-- ---------------------------------------------------------------------------
-- 2. Heclus Credits takes the general names
-- ---------------------------------------------------------------------------
--
-- NUMERIC, not INTEGER. KIE charges fractions: one image-prompt call costs 1.7
-- credits and a script 14.7. Rounding every call up would overcharge by about a
-- third on the cheap ones and rounding down would give them away, so the balance
-- carries four decimals and the arithmetic stays exact. That alone made reusing
-- the old integer wallet impossible.
--
-- One bucket, not two. Purchased credit has no expiry, so there is never
-- anything to tell it apart from.

CREATE TABLE IF NOT EXISTS credit_accounts (
  user_id    UUID PRIMARY KEY,
  -- What the user has bought and not yet spent. One bucket, because purchased
  -- credit has no expiry and so never needs to be told apart from any other.
  credits    NUMERIC(14,4) NOT NULL DEFAULT 0,
  -- Held by open reservations. Already subtracted from `credits`, so the two
  -- never double-count; this is for display and for the stale sweep.
  reserved   NUMERIC(14,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT heclus_credit_accounts_non_negative
    CHECK (credits >= 0 AND reserved >= 0)
);

-- Every movement, signed: positive adds, negative removes. Signed rather than a
-- separate direction column so a balance is always just the sum of the rows,
-- which is what makes a disagreement between account and ledger detectable.
CREATE TABLE IF NOT EXISTS credit_ledger (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL,
  kind            TEXT NOT NULL,
  credits         NUMERIC(14,4) NOT NULL,
  note            TEXT,
  -- Which provider the spend went to (kie, genaipro, anthropic). A label for
  -- reporting, not a balance: there is one balance and it pays for all of them.
  provider        TEXT,
  project_id      UUID,
  beat_number     INTEGER,
  -- Set on a topup. The unique index below is what makes a replayed payment
  -- webhook credit the account once rather than twice.
  dodo_payment_id TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT heclus_credit_ledger_kind_check
    CHECK (kind IN ('topup', 'spend', 'refund', 'adjustment')),
  CONSTRAINT heclus_credit_ledger_credits_nonzero CHECK (credits <> 0)
);

CREATE INDEX IF NOT EXISTS heclus_credit_ledger_user_time
  ON credit_ledger (user_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS heclus_credit_ledger_one_topup_per_payment
  ON credit_ledger (dodo_payment_id)
  WHERE dodo_payment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS credit_reservations (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  credits     NUMERIC(14,4) NOT NULL CHECK (credits > 0),
  state       TEXT NOT NULL DEFAULT 'open',
  provider    TEXT,
  project_id  UUID,
  beat_number INTEGER,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at  TIMESTAMPTZ,
  CONSTRAINT heclus_credit_reservations_state_check
    CHECK (state IN ('open', 'settled', 'released'))
);

CREATE INDEX IF NOT EXISTS heclus_credit_reservations_open
  ON credit_reservations (user_id) WHERE state = 'open';

-- Credit an account. Idempotent per payment: a replayed webhook hits the unique
-- index, and the caller reads that as "already credited" rather than an error.
CREATE OR REPLACE FUNCTION credits_add(
  p_user UUID, p_credits NUMERIC, p_kind TEXT DEFAULT 'topup',
  p_note TEXT DEFAULT NULL, p_payment TEXT DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_credits IS NULL OR p_credits <= 0 THEN RETURN FALSE; END IF;

  INSERT INTO credit_accounts (user_id, credits)
  VALUES (p_user, 0)
  ON CONFLICT (user_id) DO NOTHING;

  BEGIN
    INSERT INTO credit_ledger (user_id, kind, credits, note, dodo_payment_id)
    VALUES (p_user, p_kind, p_credits, p_note, p_payment);
  EXCEPTION WHEN unique_violation THEN
    -- Same payment already credited. Not an error: the webhook is at-least-once.
    RETURN FALSE;
  END;

  UPDATE credit_accounts
     SET credits = credits + p_credits, updated_at = now()
   WHERE user_id = p_user;

  RETURN TRUE;
END;
$$;

-- Hold credit before doing work. Returns the reservation id, or NULL when the
-- balance will not cover it — and NULL is a refusal the caller must obey, not a
-- warning. Reserving after starting the work would run it on credit nobody has.
CREATE OR REPLACE FUNCTION credits_reserve(
  p_user UUID, p_credits NUMERIC, p_provider TEXT DEFAULT NULL,
  p_project UUID DEFAULT NULL, p_beat INTEGER DEFAULT NULL
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  acct   credit_accounts;
  res_id UUID;
BEGIN
  IF p_credits IS NULL OR p_credits <= 0 THEN RETURN NULL; END IF;

  SELECT * INTO acct FROM credit_accounts WHERE user_id = p_user FOR UPDATE;
  IF NOT FOUND OR acct.credits < p_credits THEN RETURN NULL; END IF;

  INSERT INTO credit_reservations
    (user_id, credits, provider, project_id, beat_number)
  VALUES (p_user, p_credits, p_provider, p_project, p_beat)
  RETURNING id INTO res_id;

  UPDATE credit_accounts
     SET credits = credits - p_credits,
         reserved = reserved + p_credits,
         updated_at = now()
   WHERE user_id = p_user;

  RETURN res_id;
END;
$$;

-- The work finished. Turn the hold into a debit. p_actual is what it really
-- cost, which for KIE is only known from the response, so anything reserved and
-- not spent goes back rather than being kept.
CREATE OR REPLACE FUNCTION credits_settle(
  p_reservation UUID, p_actual NUMERIC DEFAULT NULL, p_note TEXT DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  res     credit_reservations;
  actual  NUMERIC;
  unspent NUMERIC;
BEGIN
  SELECT * INTO res FROM credit_reservations WHERE id = p_reservation FOR UPDATE;
  IF NOT FOUND OR res.state <> 'open' THEN RETURN FALSE; END IF;

  -- Never settle for more than was held: the hold is the promise the user made,
  -- and a provider overrunning it is our problem, not a surprise debit.
  actual  := LEAST(COALESCE(p_actual, res.credits), res.credits);
  unspent := res.credits - actual;

  IF actual > 0 THEN
    INSERT INTO credit_ledger
      (user_id, kind, credits, note, provider, project_id, beat_number)
    VALUES (res.user_id, 'spend', -actual, p_note, res.provider, res.project_id, res.beat_number);
  END IF;

  UPDATE credit_accounts
     SET credits = credits + unspent,
         reserved = reserved - res.credits,
         updated_at = now()
   WHERE user_id = res.user_id;

  UPDATE credit_reservations
     SET state = 'settled', settled_at = now()
   WHERE id = p_reservation;

  RETURN TRUE;
END;
$$;

-- Nothing was produced, so nothing is charged. The whole hold goes back.
CREATE OR REPLACE FUNCTION credits_release(
  p_reservation UUID, p_note TEXT DEFAULT NULL
) RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  res credit_reservations;
BEGIN
  SELECT * INTO res FROM credit_reservations WHERE id = p_reservation FOR UPDATE;
  IF NOT FOUND OR res.state <> 'open' THEN RETURN FALSE; END IF;

  UPDATE credit_accounts
     SET credits = credits + res.credits,
         reserved = reserved - res.credits,
         updated_at = now()
   WHERE user_id = res.user_id;

  UPDATE credit_reservations
     SET state = 'released', settled_at = now()
   WHERE id = p_reservation;

  RETURN TRUE;
END;
$$;

COMMENT ON TABLE credit_accounts IS
  'Heclus Credits: the general purchased wallet, spent on work running on Heclus provider accounts. The free GenAI video wallet is genai_credits.';
