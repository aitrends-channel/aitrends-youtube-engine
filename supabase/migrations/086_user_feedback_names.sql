-- Feedback rows carry the author's name so they're self-contained for
-- display (e.g. landing-page testimonials) without joining auth.users
-- at read time. Prefilled client-side from auth metadata; editable in
-- the feedback form.

ALTER TABLE user_feedback
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name  TEXT;
