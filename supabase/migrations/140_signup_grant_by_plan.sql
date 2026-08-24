-- The signup grant becomes per plan.
--
-- 100 credits was the launch figure and it was the worst available number: it
-- buys the three writing steps and about five images on the default models, so
-- a paying subscriber spent real provider money and ended with a script and a
-- partial frame set. Nothing they could watch, which is the one thing that
-- demonstrates the product.
--
-- Priced on the actual defaults (Grok Imagine at 4 credits a frame and 1.6
-- credits a second), a finished 20-beat video with voiceover is about 385
-- credits. Starter now gets 1,000 and Pro 2,000, which is a finished video with
-- real room to regenerate and try a second idea, at a cost to Heclus of $5 and
-- $10 against first months of $21 and $39.
--
-- Two columns rather than one JSON blob: there are three plans, the existing
-- column already holds the starter figure, and the admin editor is a number
-- input per value. Founder reads the Pro column, being the higher tier at $40.
-- The GenAIPro video wallet deliberately gives Founder nothing, so if the same
-- is wanted here it is a value to set, not a rule to write.

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS heclus_signup_grant_credits_pro NUMERIC;

-- Existing installs carry 100 in the starter column. Move both to the decided
-- figures, and only where the old launch value is still in place, so an admin
-- who has already tuned this is not overwritten.
UPDATE product_config
   SET heclus_signup_grant_credits = 1000
 WHERE service = '_global'
   AND (heclus_signup_grant_credits IS NULL OR heclus_signup_grant_credits = 100);

UPDATE product_config
   SET heclus_signup_grant_credits_pro = 2000
 WHERE service = '_global'
   AND heclus_signup_grant_credits_pro IS NULL;
