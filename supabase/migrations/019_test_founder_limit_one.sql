-- TEST CONFIGURATION — temporarily set the Founder cap to 1 so the
-- exhausted-state UX (modal hides Founder, claim returns NULL) can be
-- exercised end-to-end on staging/production.
--
-- TO REVERT to the original 100-spot cap, write a new migration that
-- restores the `< 100` literals in both functions and recomputes the
-- founders_promo_active flag.

CREATE OR REPLACE FUNCTION claim_founder_spot()
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  new_count INTEGER;
BEGIN
  UPDATE product_config
    SET
      founders_subscriptions_count = founders_subscriptions_count + 1,
      founders_promo_active = (founders_subscriptions_count + 1) < 1
    WHERE service = '_global'
      AND founders_promo_active = true
    RETURNING founders_subscriptions_count INTO new_count;

  RETURN new_count;
END;
$$;

CREATE OR REPLACE FUNCTION get_founder_promo_state()
RETURNS TABLE (taken INTEGER, remaining INTEGER, active BOOLEAN)
LANGUAGE sql AS $$
  SELECT
    founders_subscriptions_count AS taken,
    GREATEST(0, 1 - founders_subscriptions_count) AS remaining,
    founders_promo_active AS active
  FROM product_config
  WHERE service = '_global';
$$;

-- Recompute the active flag against the new 1-spot cap. Count is currently 1
-- so the promo flips to inactive.
UPDATE product_config
  SET founders_promo_active = founders_subscriptions_count < 1
  WHERE service = '_global';
