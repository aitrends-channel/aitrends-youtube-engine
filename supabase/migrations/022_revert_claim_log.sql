-- Revert 021's claim-log idempotency. We're going back to the simple
-- atomic-counter design from the original spec; double-fire prevention
-- lives in the client (useRef guard against React StrictMode and
-- accidental remounts).

DROP FUNCTION IF EXISTS claim_founder_spot(TEXT, UUID);
DROP TABLE IF EXISTS founder_claims_log;

-- Restore the no-arg version: single atomic UPDATE that increments the
-- counter and flips founders_promo_active off at the configured cap.
CREATE OR REPLACE FUNCTION claim_founder_spot()
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  new_count INTEGER;
BEGIN
  UPDATE product_config
    SET
      founders_subscriptions_count = founders_subscriptions_count + 1,
      founders_promo_active = (founders_subscriptions_count + 1) < 2
    WHERE service = '_global'
      AND founders_promo_active = true
    RETURNING founders_subscriptions_count INTO new_count;

  RETURN new_count;
END;
$$;
