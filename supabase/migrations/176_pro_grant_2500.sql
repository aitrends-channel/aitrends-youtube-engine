-- Pro's period grant goes from 2,000 to 2,500 credits.
--
-- At $0.005 a credit that is $12.50 of provider spend against $49.99, so 75%
-- at full burn where 2,000 was 80%. The reason to spend the five points: the
-- production ledger puts a project that uses AI video at a median of 2,211
-- credits, and 2,000 funded fewer than one of them. 2,500 clears that median,
-- which is the difference between a plan that finishes a video and one that
-- stops partway and asks for a top-up.
--
-- Starter stays at 1,000 and Max at 10,000.

UPDATE product_config
   SET heclus_signup_grant_credits_pro = 2500
 WHERE service = '_global'
   AND heclus_signup_grant_credits_pro = 2000;

-- The customer-facing bullet, kept in step with the figure above. Rewritten in
-- place rather than by replacing the whole array, so an admin's other edits to
-- the feature list survive.
UPDATE plans
   SET features = (
     SELECT jsonb_agg(
       CASE WHEN f #>> '{}' LIKE '%Heclus Credits%'
            THEN to_jsonb('2,500 Heclus Credits / month'::text)
            ELSE f END
     )
     FROM jsonb_array_elements(features) f
   )
 WHERE slug = 'heclus_pro'
   AND features::text LIKE '%2000 Heclus Credits%';
