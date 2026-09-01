-- Give Max its own entry in every stored quota.
--
-- A stored byPlan REPLACES the baseline map rather than merging with it, which
-- is deliberate: an admin clearing a plan's allowance has to actually zero it,
-- and merging would silently resurrect the default. The cost of that rule is
-- that a tier added after the config was last saved has no entry at all, so it
-- falls down the ladder to the tier below instead of taking the default meant
-- for it.
--
-- That is what happened to Max. It read Pro's 200 GB and 300 clips rather than
-- the 400 and 400 the defaults define, and showed blank in the Quotas editor
-- because nothing was stored against it.
--
-- Written per kind and only where the key is absent, so an admin who has
-- already set a Max figure keeps it.

UPDATE product_config
   SET free_quotas = jsonb_set(free_quotas, '{ai33_tts_chars,byPlan,max}', '500000'::jsonb, true)
 WHERE service = '_global'
   AND free_quotas ? 'ai33_tts_chars'
   AND NOT (free_quotas -> 'ai33_tts_chars' -> 'byPlan' ? 'max');

UPDATE product_config
   SET free_quotas = jsonb_set(free_quotas, '{voice_clones,byPlan,max}', '-1'::jsonb, true)
 WHERE service = '_global'
   AND free_quotas ? 'voice_clones'
   AND NOT (free_quotas -> 'voice_clones' -> 'byPlan' ? 'max');

UPDATE product_config
   SET free_quotas = jsonb_set(free_quotas, '{storage_bytes,byPlan,max}', '400'::jsonb, true)
 WHERE service = '_global'
   AND free_quotas ? 'storage_bytes'
   AND NOT (free_quotas -> 'storage_bytes' -> 'byPlan' ? 'max');

UPDATE product_config
   SET free_quotas = jsonb_set(free_quotas, '{genaipro_video_credits,byPlan,max}', '400'::jsonb, true)
 WHERE service = '_global'
   AND free_quotas ? 'genaipro_video_credits'
   AND NOT (free_quotas -> 'genaipro_video_credits' -> 'byPlan' ? 'max');

-- Free images has no stored entry anywhere yet, so it still resolves from the
-- defaults. Added here too, so the first save from the editor does not have to
-- be the thing that creates it.
-- The whole entry in one step, not '{free_image_credits,byPlan}'.
-- jsonb_set creates only the LAST missing level of a path: with
-- free_image_credits absent entirely, the two-level form cannot create the
-- intermediate object and returns the original value unchanged. The row still
-- matches, still reports as updated, and nothing lands -- which is how this
-- migration ran clean against production and left the quota missing.
UPDATE product_config
   SET free_quotas = jsonb_set(free_quotas, '{free_image_credits}',
         '{"byPlan": {"founder": 0, "starter": 300, "pro": 900, "max": 1500}}'::jsonb, true)
 WHERE service = '_global'
   AND NOT (free_quotas ? 'free_image_credits');
