-- Post-launch cutoff for the admin Stats section's activity chart.
-- When set, the admin stats endpoint excludes projects/users whose
-- created_at predates this timestamp from the 30-day / 12-month
-- activity aggregates — so the chart starts from launch day instead
-- of being dominated by months of dev test rows.
--
-- The aggregate totals on the cards (Total Niches, Active Accounts,
-- etc.) keep counting everything; only the trend chart is sliced.
--
-- Set by the admin Launch button (Activity tab → "Clear all?"). NULL
-- means "no cutoff, show full history" — the default state.

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS activity_cutoff_at TIMESTAMPTZ;
