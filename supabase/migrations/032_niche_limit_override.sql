-- Per-user niche-limit override. NULL = no override, fall back to the
-- plan default. A non-null value takes precedence over the plan-derived
-- limit on both /api/usage (reporting) and /api/projects (enforcement
-- via try_use_niche). Admin sets this from the Users tab modal.

ALTER TABLE app_settings
  ADD COLUMN IF NOT EXISTS niche_limit_override INTEGER;
