-- Generalise the per-service API key table into a broader product config
-- table that also holds global promo state (Founder spots).
--
-- Founder promo cap is enforced atomically: claim_founder_spot() is an
-- UPDATE with a WHERE guard, so two concurrent claims at the 100th spot
-- can't both succeed — the row-level lock guarantees only one wins.

ALTER TABLE IF EXISTS product_api_keys RENAME TO product_config;

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS founders_subscriptions_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS founders_promo_active        BOOLEAN NOT NULL DEFAULT true;

-- Singleton row that holds global product state (counters, flags).
-- Per-service rows (API keys etc.) keep the new columns at their defaults
-- and ignore them. The CHECK constraint lets us identify the meta row.
INSERT INTO product_config (service, label, keys, current_index, active)
VALUES ('_global', 'Global product config', '[]'::jsonb, 0, true)
ON CONFLICT DO NOTHING;

-- Atomically claim a Founder spot.
-- Returns the new subscriptions_count on success, NULL if the promo
-- is already inactive (i.e. 100 spots already taken).
CREATE OR REPLACE FUNCTION claim_founder_spot()
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  new_count INTEGER;
BEGIN
  -- Row-level lock during UPDATE ensures the WHERE guard is evaluated
  -- atomically against any concurrent UPDATEs.
  UPDATE product_config
    SET
      founders_subscriptions_count = founders_subscriptions_count + 1,
      founders_promo_active = (founders_subscriptions_count + 1) < 100
    WHERE service = '_global'
      AND founders_promo_active = true
    RETURNING founders_subscriptions_count INTO new_count;

  RETURN new_count;  -- NULL if no row was updated (promo inactive)
END;
$$;

-- Read current Founder promo state without locking. Caller-friendly RPC.
CREATE OR REPLACE FUNCTION get_founder_promo_state()
RETURNS TABLE (taken INTEGER, remaining INTEGER, active BOOLEAN)
LANGUAGE sql AS $$
  SELECT
    founders_subscriptions_count AS taken,
    GREATEST(0, 100 - founders_subscriptions_count) AS remaining,
    founders_promo_active AS active
  FROM product_config
  WHERE service = '_global';
$$;
