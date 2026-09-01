-- The revised allowances for the plans on sale.
--
--   Starter  images 450 -> 300
--   Pro      clips  300 -> 200
--   Max      credits 7,000 -> 6,000
--
-- Sized so each tier clears 50% gross once Dodo's 10% and GOG's 5% come off
-- the top. Clips move before credits because a clip is hard per-unit spend at
-- $0.02 with no refund path, where the wallet settles on what the work actually
-- cost and returns the rest.
--
-- Prices are NOT changed here. At the prices these plans carry today the set
-- lands at 49/44/46%, and reaching 50% needs $30.99, $59.99 and $149. Each of
-- those is a new Dodo product, so it is a deliberate step of its own.

UPDATE product_config
   SET heclus_signup_grant_credits_max = 6000
 WHERE service = '_global'
   AND heclus_signup_grant_credits_max = 7000;

UPDATE plans
   SET features = (
     SELECT jsonb_agg(
       CASE WHEN f #>> '{}' LIKE '%Heclus Credits%'
            THEN to_jsonb('6,000 Heclus Credits / month'::text)
            ELSE f END
     )
     FROM jsonb_array_elements(features) f
   )
 WHERE slug = 'heclus_max'
   AND features::text LIKE '%7,000 Heclus Credits%';

-- The cards advertise the free allowances, so they move with the config.
UPDATE plans
   SET features = (
     SELECT jsonb_agg(
       CASE WHEN f #>> '{}' LIKE '%image generation credits%'
            THEN to_jsonb('Free 300 image generation credits / month'::text)
            WHEN f #>> '{}' LIKE '%video generation credits%'
            THEN to_jsonb('Free 150 video generation credits / month'::text)
            ELSE f END
     )
     FROM jsonb_array_elements(features) f
   )
 WHERE slug = 'heclus_starter';

UPDATE plans
   SET features = (
     SELECT jsonb_agg(
       CASE WHEN f #>> '{}' LIKE '%image generation credits%'
            THEN to_jsonb('Free 900 image generation credits / month'::text)
            WHEN f #>> '{}' LIKE '%video generation credits%'
            THEN to_jsonb('Free 200 video generation credits / month'::text)
            ELSE f END
     )
     FROM jsonb_array_elements(features) f
   )
 WHERE slug = 'heclus_pro';

-- Max's card still advertised the 600 clips migration 179 wrote, and carried no
-- image line at all. Both brought in step with the config.
UPDATE plans
   SET features = (
     SELECT jsonb_agg(
       CASE WHEN f #>> '{}' LIKE '%video generation credits%'
            THEN to_jsonb('Free 400 video generation credits / month'::text)
            ELSE f END
     )
     FROM jsonb_array_elements(features) f
   )
 WHERE slug = 'heclus_max';

UPDATE plans
   SET features = features || to_jsonb('Free 1,500 image generation credits / month'::text)
 WHERE slug = 'heclus_max'
   AND features::text NOT LIKE '%image generation credits%';
