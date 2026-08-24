-- Watch the provider accounts draw down, so a charge nobody recorded is visible.
--
-- The monthly rate check divides an invoice by a volume. KIE issues no invoice
-- and publishes no price list we can compare a credit count against, so the
-- largest spender of the four providers has no check at all, and PoYo has only
-- its catalog. Neither would notice the failure that actually happened: a task
-- that bills and whose finish we never read is charged by the provider and
-- absent from project_costs, so the wallet under-bills and the margin erodes
-- with nothing to show it. Finished PoYo clips were being bought twice in
-- August and every existing check was blind to it.
--
-- What can be observed instead is the account balance, which both providers
-- expose and the API status card already reads. Snapshot it on a schedule and
-- two questions become answerable that were not:
--
--   Spend we never recorded. Sum the drops between consecutive snapshots and
--   compare against the credits the ledger recorded over the same window. Only
--   drops count as spend; a rise is a top-up, not negative consumption.
--
--   What a credit is worth in dollars. A rise IS a top-up, so it is also the
--   credits half of a price: enter what was paid and usd_per_credit falls out.
--   That figure is USD_PER_CREDIT in lib/pricing.ts, every dollar in the wallet
--   rests on it, and until now nothing could confirm it at all.
--
-- The balance is per provider account and the account is shared by every user,
-- so this detects at the account level and attributes nothing. A gap says the
-- total is off; finding which beat leaked it is still the Jobs tab.

CREATE TABLE IF NOT EXISTS provider_balances (
  id         BIGSERIAL   PRIMARY KEY,
  provider   TEXT        NOT NULL,
  -- The provider's own unit, not Heclus credits. Signed: KIE reports a negative
  -- balance when the account is overdrawn, and clamping that to zero would hide
  -- exactly the state worth seeing.
  credits    NUMERIC     NOT NULL,
  taken_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Every read walks one provider in time order.
CREATE INDEX IF NOT EXISTS idx_provider_balances_provider_taken
  ON provider_balances (provider, taken_at DESC);

-- What a provider credit costs in dollars, confirmed against a real payment.
--
-- One row per confirmation rather than a single mutable value, so the history is
-- the audit trail: when the rate was checked, what was paid, and what it worked
-- out to. A rate that has not been confirmed in months is then a fact the
-- dashboard can state rather than a silence.
CREATE TABLE IF NOT EXISTS provider_credit_prices (
  id             BIGSERIAL   PRIMARY KEY,
  provider       TEXT        NOT NULL,
  /** Credits the top-up added, normally the observed rise in provider_balances. */
  credits        NUMERIC     NOT NULL CHECK (credits > 0),
  /** Dollars actually paid for them, from the receipt. */
  usd_paid       NUMERIC     NOT NULL CHECK (usd_paid > 0),
  /** Derived, stored so a reader does not repeat the division. */
  usd_per_credit NUMERIC     NOT NULL CHECK (usd_per_credit > 0),
  note           TEXT,
  confirmed_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_provider_credit_prices_provider
  ON provider_credit_prices (provider, confirmed_at DESC);
