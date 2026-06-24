-- Refresh the Pro plan feature bullets in the subscription modal.
-- Repositions Pro from "unlimited cloning" toward a "10 niches +
-- 2K output" message.
--
-- Idempotent: gated on the features array still matching the pre-
-- change seed from migration 059, so re-runs and prior admin edits
-- are both safe.
--
-- NOTE: this migration changes the *displayed* feature bullets only.
-- The underlying enforcement column plans.niches_per_month is still
-- NULL (unlimited) and limit_display is still "Unlimited niches".
-- If Pro should actually be capped at 10 niches/month, follow up
-- with an UPDATE to those two columns — otherwise customers will
-- read "10 niches" but server-side try_use_niche will let them
-- create more.

UPDATE plans
SET features = '[
  "Everything in Starter",
  "10 niches",
  "Unlimited videos",
  "Bulk video generation",
  "Priority rendering queue",
  "Priority support",
  "2K+ premium output"
]'::jsonb
WHERE slug = 'pro'
  AND features = '[
    "Everything in Starter",
    "Clone unlimited YouTube niches",
    "Unlimited video creation",
    "Bulk video generation",
    "Priority rendering queue",
    "Priority support"
  ]'::jsonb;
