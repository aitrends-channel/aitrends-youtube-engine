-- Pro's period grant back to 2,000 credits.
--
-- 176 raised it to 2,500 on the reasoning that the median AI-video project
-- costs 2,211 credits and 2,000 did not fund one. That reasoning was sound and
-- the arithmetic underneath it was not: at 2,500 credits, with Dodo at 10% and
-- GOG at 5% taken off the top, Pro earned 35% and netted $17.39 against
-- Starter's $14.19. A tier that costs the customer $20 more and returns $3.20
-- more is not a rung on a ladder.
--
-- 2,000 credits is $10 of provider spend rather than $12.50. Pro still does not
-- fund a median video-model project outright, which is a real limitation, but
-- the credits are a wallet: what is not spent settles back, and what is needed
-- beyond the grant is a top-up rather than a wall.

UPDATE product_config
   SET heclus_signup_grant_credits_pro = 2000
 WHERE service = '_global'
   AND heclus_signup_grant_credits_pro = 2500;

UPDATE plans
   SET features = (
     SELECT jsonb_agg(
       CASE WHEN f #>> '{}' LIKE '%Heclus Credits%'
            THEN to_jsonb('2,000 Heclus Credits / month'::text)
            ELSE f END
     )
     FROM jsonb_array_elements(features) f
   )
 WHERE slug = 'heclus_pro'
   AND features::text LIKE '%2,500 Heclus Credits%';
