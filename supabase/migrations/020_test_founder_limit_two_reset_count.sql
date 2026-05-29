-- TEST CONFIGURATION — raise the Founder cap from 1 to 2 and reset the
-- counter to 0 so the full claim → claim → exhaust flow can be exercised
-- against a fresh state.
--
-- TO REVERT to the original 100-spot cap, write a new migration that
-- restores the '< 100' literals in both functions.

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

CREATE OR REPLACE FUNCTION get_founder_promo_state()
RETURNS TABLE (taken INTEGER, remaining INTEGER, active BOOLEAN)
LANGUAGE sql AS $$
  SELECT
    founders_subscriptions_count AS taken,
    GREATEST(0, 2 - founders_subscriptions_count) AS remaining,
    founders_promo_active AS active
  FROM product_config
  WHERE service = '_global';
$$;

-- Reset the counter to 0 and re-arm the promo flag for a clean test run.
UPDATE product_config
  SET
    founders_subscriptions_count = 0,
    founders_promo_active        = true
  WHERE service = '_global';
