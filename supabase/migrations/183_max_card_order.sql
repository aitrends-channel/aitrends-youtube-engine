-- Put Max's card back in a known order.
--
-- Migrations 178 to 181 each inserted a line relative to another one, and the
-- positions compounded: the free-images line had drifted below Priority
-- support. Setting the array once is shorter than another positional insert.
--
-- Voice cloning is deliberately not listed. Max grants it, through
-- voice_clones.max = -1, but "Everything in Pro" already carries it and Pro's
-- card spells it out. The allowances below are listed only because Max's
-- figures differ from Pro's; anything identical to Pro stays in that one line.

UPDATE plans
   SET features = '[
     "Everything in Pro",
     "Unlimited niches",
     "6,000 Heclus Credits / month",
     "4K output",
     "Transitions, motion and the full effects library",
     "Text overlays, elements and sound effects",
     "Custom sound effects and elements",
     "Multi-track timeline editing",
     "Free 1,500 image generation credits / month",
     "Free 400 video generation credits / month",
     "Free 500,000 voiceover characters / month",
     "400 GB asset storage",
     "Priority rendering queue",
     "Priority support"
   ]'::jsonb
 WHERE slug = 'heclus_max';
