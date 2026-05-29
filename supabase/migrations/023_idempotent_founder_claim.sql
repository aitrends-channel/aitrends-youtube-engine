-- Production-grade idempotency for Founder slot claims.
-- A claim is the act of consuming one of the 100 (or current cap)
-- Founder slots. Without idempotency, any duplicate verify call —
-- React StrictMode in dev, user-triggered page reload, network
-- retry, serverless cold-start retry — would consume an extra slot.
--
-- Design: gateway transaction id (payment_id) is the natural
-- idempotency key. The claims log holds it as PRIMARY KEY, so
-- physically only one row per payment can exist. The claim RPC
-- inserts the row first and only increments the counter when the
-- insert actually happened (ROW_COUNT > 0). Duplicate calls become
-- no-ops returning the current state.

CREATE TABLE IF NOT EXISTS founder_claims_log (
  payment_id  TEXT PRIMARY KEY,
  user_id     UUID NOT NULL,
  claimed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Replace the parameterless function with one that takes the
-- payment_id and user_id. Drop the no-arg overload so the only way
-- to call this RPC is with idempotency keys.
CREATE OR REPLACE FUNCTION claim_founder_spot(p_payment_id TEXT, p_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  new_count     INTEGER;
  rows_inserted INTEGER;
BEGIN
  -- Reserve this payment_id atomically. Conflict means another call
  -- has already claimed (or attempted to claim) for this payment.
  INSERT INTO founder_claims_log (payment_id, user_id)
  VALUES (p_payment_id, p_user_id)
  ON CONFLICT (payment_id) DO NOTHING;

  GET DIAGNOSTICS rows_inserted = ROW_COUNT;

  IF rows_inserted = 0 THEN
    -- Duplicate call for the same payment. Return current count
    -- without touching the counter. Callers can rely on this being
    -- a non-mutating success.
    SELECT founders_subscriptions_count INTO new_count
    FROM product_config WHERE service = '_global';
    RETURN new_count;
  END IF;

  -- New payment_id — actually consume a slot.
  UPDATE product_config
    SET
      founders_subscriptions_count = founders_subscriptions_count + 1,
      founders_promo_active = (founders_subscriptions_count + 1) < 2
    WHERE service = '_global'
      AND founders_promo_active = true
    RETURNING founders_subscriptions_count INTO new_count;

  -- If the promo was already inactive, undo the reservation so a
  -- future retry with the same payment_id behaves consistently
  -- (and so we don't leave an orphan row for a non-claim).
  IF new_count IS NULL THEN
    DELETE FROM founder_claims_log WHERE payment_id = p_payment_id;
    RETURN NULL;
  END IF;

  RETURN new_count;
END;
$$;

-- Drop the no-arg overload so callers must pass the idempotency key.
DROP FUNCTION IF EXISTS claim_founder_spot();
