-- Rebrand plan prices: Starter $19 → $21, Pro $49 → $39. Founder
-- stays at $40. Updates the price_display column on the plans table
-- so the subscription modal renders the new values.
--
-- Idempotent: each UPDATE is gated on the prior value matching the
-- pre-change string, so re-running this migration after the prices
-- have already been changed (admin edits via the Plans tab, or a
-- repeated migration run) is a no-op rather than overwriting newer
-- edits. If an admin has already moved Starter to e.g. $24, this
-- migration won't drag it back to $21.

UPDATE plans
SET price_display = '$21'
WHERE slug = 'starter' AND price_display = '$19';

UPDATE plans
SET price_display = '$39'
WHERE slug = 'pro' AND price_display = '$49';
