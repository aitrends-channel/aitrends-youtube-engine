-- Add an "Up to 1080p output" bullet to the Founder plan in the
-- subscription modal. Inserted before the "1 year — no renewal" line
-- so the term closer stays last.
--
-- Idempotent: gated on the features array still matching the seed
-- from migration 059. If an admin has edited the features via the
-- Plans tab since then, the WHERE clause won't match and this
-- migration is a no-op rather than clobbering the admin's edit.

UPDATE plans
SET features = '[
  "20 niches",
  "HD image processing",
  "Full AI pipeline",
  "All features included",
  "Up to 1080p output",
  "1 year — no renewal"
]'::jsonb
WHERE slug = 'founder'
  AND features = '[
    "20 niches",
    "HD image processing",
    "Full AI pipeline",
    "All features included",
    "1 year — no renewal"
  ]'::jsonb;
