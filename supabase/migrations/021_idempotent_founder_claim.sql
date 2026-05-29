-- Make claim_founder_spot idempotent per payment_id so a duplicate call
-- (React StrictMode double-effect, user reload, webhook + verify race,
-- transient network retry) cannot consume more than one Founder slot.

CREATE TABLE IF NOT EXISTS founder_claims_log (
  payment_id  TEXT PRIMARY KEY,
  user_id     UUID NOT NULL,
  claimed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Replace the parameterless function with one that takes the payment_id
-- and the user_id. The first call for a given payment_id increments
-- the counter; subsequent calls return the current count without
-- incrementing, so callers can safely retry.
CREATE OR REPLACE FUNCTION claim_founder_spot(p_payment_id TEXT, p_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  new_count     INTEGER;
  rows_inserted INTEGER;
BEGIN
  -- Atomically reserve this payment_id. Conflict means we've already
  -- claimed a spot for this payment — make the call a no-op.
  INSERT INTO founder_claims_log (payment_id, user_id)
  VALUES (p_payment_id, p_user_id)
  ON CONFLICT (payment_id) DO NOTHING;

  GET DIAGNOSTICS rows_inserted = ROW_COUNT;

  IF rows_inserted = 0 THEN
    SELECT founders_subscriptions_count INTO new_count
    FROM product_config WHERE service = '_global';
    RETURN new_count;
  END IF;

  -- New payment_id — actually claim a spot.
  UPDATE product_config
    SET
      founders_subscriptions_count = founders_subscriptions_count + 1,
      founders_promo_active = (founders_subscriptions_count + 1) < 2
    WHERE service = '_global'
      AND founders_promo_active = true
    RETURNING founders_subscriptions_count INTO new_count;

  -- If the promo was already inactive, undo the claim-log reservation
  -- so a later retry with the same payment_id behaves identically.
  IF new_count IS NULL THEN
    DELETE FROM founder_claims_log WHERE payment_id = p_payment_id;
    RETURN NULL;
  END IF;

  RETURN new_count;
END;
$$;

-- Drop the old no-arg overload so callers must pass the payment_id.
DROP FUNCTION IF EXISTS claim_founder_spot();
