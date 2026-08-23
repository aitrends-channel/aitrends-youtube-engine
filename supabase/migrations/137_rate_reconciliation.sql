-- The last rate reconciliation: what we bill per provider unit against what the
-- provider actually invoiced.
--
-- Stored rather than computed on demand because reading it costs two Anthropic
-- org API calls and an ElevenLabs call, and the admin panel would make them on
-- every render. The monthly cron writes this column; the panel reads it.
--
-- NULL means it has never run, which is what the panel says.
ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS rate_reconciliation JSONB;

COMMENT ON COLUMN product_config.rate_reconciliation IS
  'Last output of reconcileRates() in lib/rates/reconcile.ts: { at, from, to, findings[], drifted[], problems[] }. Written by /api/cron/reconcile-rates, read by the admin Heclus Credits tab. Advisory only — nothing bills from this.';
