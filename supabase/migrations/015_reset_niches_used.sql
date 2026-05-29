-- Reset the niches_used counter to zero. Called from the payment webhook
-- on any successful payment (repurchase or upgrade), so the user gets a
-- fresh allocation matching their new (or renewed) plan.

CREATE OR REPLACE FUNCTION reset_niches_used(uid UUID)
RETURNS INTEGER
LANGUAGE plpgsql AS $$
DECLARE
  new_count INTEGER;
BEGIN
  -- If the user already has an app_settings row, zero its counter.
  UPDATE app_settings SET niches_used = 0
    WHERE user_id = uid
    RETURNING niches_used INTO new_count;

  -- Otherwise create a row at zero.
  IF new_count IS NULL THEN
    INSERT INTO app_settings (user_id, niches_used) VALUES (uid, 0)
    ON CONFLICT (user_id) DO UPDATE SET niches_used = 0
    RETURNING niches_used INTO new_count;
  END IF;

  RETURN new_count;
END;
$$;
