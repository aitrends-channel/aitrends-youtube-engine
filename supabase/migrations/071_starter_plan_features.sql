-- Refresh the Starter plan feature bullets in the subscription modal:
-- rewords the niches line ("5 niches/month" → "5 niches per month")
-- and adds a new "Up to 1080p output" bullet at the end.
--
-- Idempotent: gated on the features array still matching the
-- pre-change seed from migration 059. If an admin has edited the
-- features via the Plans tab since then, the WHERE clause won't
-- match and this migration is a no-op rather than clobbering the
-- admin's customization.

UPDATE plans
SET features = '[
  "5 niches per month",
  "Standard image processing",
  "Full AI pipeline",
  "All features included",
  "Community support",
  "Up to 1080p output"
]'::jsonb
WHERE slug = 'starter'
  AND features = '[
    "5 niches/month",
    "Standard image processing",
    "Full AI pipeline",
    "All features included",
    "Community support"
  ]'::jsonb;
