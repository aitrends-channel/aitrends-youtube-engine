-- Make the Founder-promo cap admin-configurable instead of being
-- hardcoded in two SQL functions + a TypeScript constant. Adds a
-- founders_promo_limit column to product_config and rewrites both RPCs
-- to read the cap from that column.

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS founders_promo_limit INTEGER NOT NULL DEFAULT 100;

-- Return the limit alongside taken/remaining/active so the API and UI
-- can render it without keeping their own hardcoded fallback in sync.
CREATE OR REPLACE FUNCTION get_founder_promo_state()
RETURNS TABLE (taken INTEGER, remaining INTEGER, active BOOLEAN, "limit" INTEGER)
LANGUAGE sql AS $$
  SELECT
    founders_subscriptions_count                                              AS taken,
    GREATEST(0, founders_promo_limit - founders_subscriptions_count)          AS remaining,
    founders_promo_active                                                      AS active,
    founders_promo_limit                                                       AS "limit"
  FROM product_config
  WHERE service = '_global';
$$;

-- Same idempotent claim from migration 023, but the active-flag math
-- now compares against the column instead of a literal.
CREATE OR REPLACE FUNCTION claim_founder_spot(p_payment_id TEXT, p_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  new_count     INTEGER;
  rows_inserted INTEGER;
  cap           INTEGER;
BEGIN
  INSERT INTO founder_claims_log (payment_id, user_id)
  VALUES (p_payment_id, p_user_id)
  ON CONFLICT (payment_id) DO NOTHING;

  GET DIAGNOSTICS rows_inserted = ROW_COUNT;

  IF rows_inserted = 0 THEN
    SELECT founders_subscriptions_count INTO new_count
    FROM product_config WHERE service = '_global';
    RETURN new_count;
  END IF;

  SELECT founders_promo_limit INTO cap
  FROM product_config WHERE service = '_global';

  UPDATE product_config
    SET
      founders_subscriptions_count = founders_subscriptions_count + 1,
      founders_promo_active        = (founders_subscriptions_count + 1) < cap
    WHERE service = '_global'
      AND founders_promo_active = true
    RETURNING founders_subscriptions_count INTO new_count;

  IF new_count IS NULL THEN
    DELETE FROM founder_claims_log WHERE payment_id = p_payment_id;
    RETURN NULL;
  END IF;

  RETURN new_count;
END;
$$;
