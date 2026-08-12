-- A place to keep what customers keep asking for.
--
-- Requests arrive in tickets, in chat, in email and in calls, and until now the
-- only record of them was whoever remembered. This is the admin's own list: it
-- is written from the dashboard, never by a customer, so there is no submission
-- path to secure and no notion of a request the requester can edit.
--
-- asked_count is the reason the table exists. One person asking is an anecdote;
-- the same thing asked six times is a roadmap, and that count is the only part
-- nobody can reconstruct later from the mailbox.

CREATE TABLE IF NOT EXISTS feature_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title        TEXT NOT NULL,
  notes        TEXT,
  status       TEXT NOT NULL DEFAULT 'new',
  -- Who asked, most recently. Free text rather than a user reference: plenty of
  -- requests come from someone with no account, or from a call, and a foreign
  -- key would mean dropping exactly those.
  requester    TEXT,
  asked_count  INTEGER NOT NULL DEFAULT 1,
  -- Where it came from, as the ticket reference when it was filed from one
  -- ("HS30"). Two jobs: it takes you back to the customer's own words months
  -- later, and it is what the Create to-do button checks so the same ticket
  -- cannot be filed twice.
  source       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT feature_requests_status_check
    CHECK (status IN ('new', 'planned', 'shipped', 'declined')),
  CONSTRAINT feature_requests_asked_count_check CHECK (asked_count >= 1)
);

-- source arrived a few hours after the table did, and by then the table existed
-- in two databases. CREATE TABLE IF NOT EXISTS skips its whole body when the
-- table is already there, column list included, so re-running the file above
-- would not have added it. Every column therefore also arrives as an ALTER, and
-- this file stays safe to run as many times as it takes.
ALTER TABLE feature_requests
  ADD COLUMN IF NOT EXISTS source TEXT;

-- Admin-only data. No policy is created: every read and write goes through
-- /api/admin/feature-requests on the service role, and with RLS on and no
-- policy, a leaked anon key still sees nothing here.
ALTER TABLE feature_requests ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE feature_requests IS
  'Admin-maintained list of what customers have asked for. Written only from the admin dashboard.';
COMMENT ON COLUMN feature_requests.asked_count IS
  'How many separate people have asked for this. The point of the table.';
COMMENT ON COLUMN feature_requests.source IS
  'Ticket reference it was filed from, e.g. HS30. Checked by the Create to-do button so one ticket cannot be filed twice.';
