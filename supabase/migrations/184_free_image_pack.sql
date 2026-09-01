-- A top-up that buys free images, and nothing else.
--
-- Its own product rather than the general Heclus wallet. The two are not
-- interchangeable: the wallet is spent on whatever the customer generates at
-- whatever that model costs, where this buys images on the one cheap model the
-- free lane runs on. Selling one and delivering the other is the mistake the
-- separate heclus/genai top-up routes already exist to prevent.
--
-- Purchased images do not expire, which is what separates them from the monthly
-- allowance. Held as a bonus on the account rather than as a ledger, because
-- there is nothing to reserve or settle: an image is claimed or it is not.

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS heclus_free_image_top_checkout_url_test TEXT,
  ADD COLUMN IF NOT EXISTS heclus_free_image_top_checkout_url_production TEXT,
  ADD COLUMN IF NOT EXISTS heclus_free_image_top_credits NUMERIC,
  ADD COLUMN IF NOT EXISTS heclus_free_image_top_price_usd NUMERIC;

ALTER TABLE account_settings
  ADD COLUMN IF NOT EXISTS free_image_bonus INTEGER NOT NULL DEFAULT 0;

-- Every purchase, so a top-up is idempotent on the payment id the same way the
-- credit ledger is, and so support can see what somebody bought.
CREATE TABLE IF NOT EXISTS free_image_purchases (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  images          INTEGER NOT NULL CHECK (images > 0),
  dodo_payment_id TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The idempotency, enforced by the index rather than by a route being careful.
-- A refreshed return page, a double-mounted effect and a shared link all
-- collapse to one grant.
CREATE UNIQUE INDEX IF NOT EXISTS free_image_purchases_payment_idx
  ON free_image_purchases (dodo_payment_id);
CREATE INDEX IF NOT EXISTS free_image_purchases_user_idx
  ON free_image_purchases (user_id, created_at DESC);

ALTER TABLE free_image_purchases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS free_image_purchases_own ON free_image_purchases;
CREATE POLICY free_image_purchases_own ON free_image_purchases
  FOR SELECT USING (auth.uid() = user_id);

-- Grant in one statement, so the insert and the balance cannot disagree.
-- Returns false when the payment was already credited.
CREATE OR REPLACE FUNCTION grant_free_images(p_user UUID, p_images INTEGER, p_payment TEXT)
  RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  IF p_images IS NULL OR p_images <= 0 THEN RETURN FALSE; END IF;
  BEGIN
    INSERT INTO free_image_purchases (user_id, images, dodo_payment_id)
    VALUES (p_user, p_images, p_payment);
  EXCEPTION WHEN unique_violation THEN
    RETURN FALSE;
  END;
  INSERT INTO account_settings (user_id, free_image_bonus)
  VALUES (p_user, p_images)
  ON CONFLICT (user_id) DO UPDATE
    SET free_image_bonus = account_settings.free_image_bonus + EXCLUDED.free_image_bonus;
  RETURN TRUE;
END;
$$;
