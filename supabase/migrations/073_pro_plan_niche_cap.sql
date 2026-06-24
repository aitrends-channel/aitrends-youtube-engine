-- Cap the Pro plan at 10 niches/month (was previously unlimited).
-- Migration 072 already updated the displayed feature bullets to say
-- "10 niches"; this one promotes that to a real server-side cap by
-- flipping niches_per_month and limit_display.
--
-- Idempotent: gated on niches_per_month still being NULL so re-runs
-- and prior admin edits don't get overwritten.
--
-- After this lands, try_use_niche enforces the 10 niches/month cap
-- on every Pro customer. Existing Pro customers who have already
-- consumed more than 10 this billing period won't be retroactively
-- reset — niches_used is independent of niches_per_month — but they
-- won't be able to create new niches until either their counter
-- rolls over or you bump their override via the admin UI.

UPDATE plans
SET
  niches_per_month = 10,
  limit_display    = '10 niches/month'
WHERE slug = 'pro'
  AND niches_per_month IS NULL;
