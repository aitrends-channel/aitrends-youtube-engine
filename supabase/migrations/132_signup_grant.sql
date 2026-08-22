-- The starter credits a new account arrives with.
--
-- A column rather than a code constant because it is a spend decision that will
-- change: the launch figure is provisional, set so the flow can be built and
-- tested, and the real number comes out of the pricing work. Changing it must
-- not need a deploy.
ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS heclus_signup_grant_credits NUMERIC(14,4);

-- Provisional. At roughly 1.7 KIE credits per image prompt this does not cover a
-- full video, which is deliberate for now: it proves the flow end to end without
-- committing Heclus to the cost of a finished project per signup.
UPDATE product_config
   SET heclus_signup_grant_credits = 100
 WHERE service = '_global'
   AND heclus_signup_grant_credits IS NULL;

COMMENT ON COLUMN product_config.heclus_signup_grant_credits IS
  'Heclus Credits granted once per account, on first balance read. 0 or NULL disables the grant. Idempotent per user via credit_ledger.dodo_payment_id = signup:<user_id>.';
