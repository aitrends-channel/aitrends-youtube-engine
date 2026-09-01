-- Max's allowances, and its credit grant cut to 7,000.
--
-- Sized against production rather than guessed. Voiceover: 339 projects with a
-- voiceover use a median of 12,648 characters, so 500,000 is about 40 videos a
-- month, which is the shape of a tier sold on unlimited niches.
--
-- Free video credits climb more slowly than everything else on purpose. They
-- are the one allowance billed as hard per-unit spend, $0.02 a clip through
-- GenAIPro with no refund path, where Heclus credits settle on what the work
-- actually cost and hand back the difference. 600 is two $6 packs.
--
-- Cost of the tier at full burn: $35 of credits, $12 of clips, $6 of storage,
-- plus voiceover, against $129. The voiceover line cannot be costed yet because
-- AI33_TTS_USD_PER_MILLION_CHARS is unset in the environment.

UPDATE product_config
   SET heclus_signup_grant_credits_max = 7000
 WHERE service = '_global'
   AND heclus_signup_grant_credits_max = 10000;

UPDATE plans
   SET features = '[
     "Everything in Pro",
     "Unlimited niches",
     "7,000 Heclus Credits / month",
     "4K output",
     "Transitions, motion and the full effects library",
     "Text overlays, elements and sound effects",
     "Custom sound effects and elements",
     "Multi-track timeline editing",
     "Free 500,000 voiceover characters / month",
     "Free 600 video generation credits / month",
     "400 GB asset storage",
     "Priority rendering queue",
     "Priority support"
   ]'::jsonb
 WHERE slug = 'heclus_max';
