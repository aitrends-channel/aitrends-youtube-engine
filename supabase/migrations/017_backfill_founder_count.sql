-- Backfill the founders_subscriptions_count from the current number of
-- users who actually have plan = 'founder' in auth.users metadata.
-- Also flips founders_promo_active off if we already hit the 100-spot cap.

UPDATE product_config
  SET
    founders_subscriptions_count = sub.cnt,
    founders_promo_active        = sub.cnt < 100
  FROM (
    SELECT COUNT(*)::INTEGER AS cnt
    FROM auth.users
    WHERE raw_app_meta_data->>'plan' = 'founder'
  ) AS sub
  WHERE service = '_global';
