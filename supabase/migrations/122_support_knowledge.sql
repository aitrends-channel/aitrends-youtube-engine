-- Admin-editable knowledge for the support agent.
--
-- lib/support-agent/product-knowledge.ts holds the permanent briefing: what
-- Heclus is, the workflow, which key does what. That belongs in code — it is
-- reviewed, versioned, and changes when the product does.
--
-- This table is for everything else: the answer to whatever came up this week,
-- a policy, a workaround, a known upstream outage. Those need to reach the agent
-- in a minute from the dashboard, not in a deploy, and they need to be
-- retractable just as fast when they stop being true.
--
-- Read on every question, so keep entries short and few. This is a briefing
-- appended to a prompt, not a wiki: a hundred stale entries would cost tokens on
-- every turn and bury the ones that matter.

CREATE TABLE IF NOT EXISTS support_knowledge (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What the entry is about. Also what the agent sees as its heading, so write
  -- it as a topic ("Refund policy"), not a ticket reference.
  title       TEXT        NOT NULL,
  content     TEXT        NOT NULL,
  -- Off keeps the text without feeding it to the agent — the retraction path
  -- that does not lose the wording.
  enabled     BOOLEAN     NOT NULL DEFAULT true,
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  -- Who last touched it, for when an answer turns out to be wrong.
  updated_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS support_knowledge_enabled_idx
  ON support_knowledge (sort_order, created_at)
  WHERE enabled = true;

-- Server-side only: the agent reads it with the service role and the admin UI
-- goes through requireAdmin. No client ever queries this table directly, so RLS
-- with no policy is the correct posture rather than an oversight.
ALTER TABLE support_knowledge ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE support_knowledge IS
  'Admin-editable notes appended to the support agent prompt. Permanent product knowledge lives in lib/support-agent/product-knowledge.ts; this is for policies, workarounds and current events.';
