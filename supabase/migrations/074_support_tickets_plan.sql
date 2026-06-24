-- Snapshot the user's plan slug onto every new support ticket so the
-- admin queue can prioritize triage by tier (e.g. Pro = priority
-- support per the modal copy). Captured at ticket-creation time —
-- if the user upgrades or downgrades later, the ticket still shows
-- "what plan they had when they asked", which is the more useful
-- frame for SLA / support-policy decisions.
--
-- Nullable on purpose: anonymous visitors filing tickets via the
-- HelpButton from marketing / auth pages don't have a plan. Backfill
-- of existing rows stays NULL — we don't know what their plan was
-- at the time of filing, and reading "current plan" instead would
-- be misleading.
--
-- Re-run safe: ADD COLUMN IF NOT EXISTS.

ALTER TABLE support_tickets
  ADD COLUMN IF NOT EXISTS plan TEXT;

CREATE INDEX IF NOT EXISTS support_tickets_plan_open_created_idx
  ON support_tickets (plan, created_at DESC)
  WHERE is_open = true;
