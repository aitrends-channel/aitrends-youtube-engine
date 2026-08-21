-- Who pays for a user's generations.
--
--   byo    – the user's own KIE and ElevenLabs keys, billed to their accounts.
--            What every account did before this column existed.
--   wallet – Heclus's provider accounts, metered against the Heclus Credits
--            wallet. What a new signup gets, so there is nothing to connect
--            before making a first video.
--
-- Per user rather than per plan: a plan says what someone bought, this says
-- whose key runs the call, and clients on either mode exist on every plan.
ALTER TABLE account_settings
  ADD COLUMN IF NOT EXISTS funding_mode TEXT;

-- Existing rows are BYO by definition: they have keys configured and have been
-- spending them. Backfilled explicitly rather than left NULL so nobody's
-- generations silently move onto Heclus's account on deploy.
UPDATE account_settings SET funding_mode = 'byo' WHERE funding_mode IS NULL;

-- New rows default to wallet: an account created from here on has nothing to
-- connect, which is the point of the wallet. The no-row-at-all case (a signup
-- that has never saved a setting) resolves to wallet in lib/funding.ts, since a
-- column default cannot cover a row that does not exist.
ALTER TABLE account_settings
  ALTER COLUMN funding_mode SET DEFAULT 'wallet';

ALTER TABLE account_settings
  ADD CONSTRAINT account_settings_funding_mode_check
  CHECK (funding_mode IS NULL OR funding_mode IN ('byo', 'wallet'));

COMMENT ON COLUMN account_settings.funding_mode IS
  'byo = the user''s own provider keys; wallet = Heclus keys metered against Heclus Credits. NULL means wallet, which is the default for accounts created after migration 131.';
