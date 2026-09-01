-- Max gains custom sound effects and elements, so its card says so.
--
-- The whole array rather than an append: the new line belongs beside the other
-- editor capabilities, not after "Priority support", and Max is new enough that
-- there are no admin edits to preserve. Migration 175 wrote this list; this
-- replaces it.

UPDATE plans
   SET features = '[
     "Everything in Pro",
     "Unlimited niches",
     "10,000 Heclus Credits / month",
     "4K output",
     "Transitions, motion and the full effects library",
     "Text overlays, elements and sound effects",
     "Custom sound effects and elements",
     "Multi-track timeline editing",
     "Priority rendering queue",
     "Priority support"
   ]'::jsonb
 WHERE slug = 'heclus_max';
