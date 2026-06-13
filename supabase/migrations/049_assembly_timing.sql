-- Track per-assembly wall-clock duration on the projects row.
--
-- assembly_started_at  → stamped when the worker claims the project
--                       (poll-loop claim OR direct /api/assemble call).
--                       Also reset on Resume so each fresh run measures
--                       its own wall-clock, not the cumulative work across
--                       Stop/Resume cycles. A long-running project that
--                       was Stopped and Resumed 30 minutes later should
--                       not look like a 30-minute assembly.
--
-- assembly_finished_at → stamped on the terminal transition: done,
--                       failed, OR stopped. The "stopped" case is
--                       useful too — knowing how long a user let it
--                       run before clicking Stop is a real signal.
--
-- Duration is derived in SQL (assembly_finished_at - assembly_started_at).
-- Not stored separately to avoid keeping two sources of truth in sync.

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS assembly_started_at  timestamptz,
  ADD COLUMN IF NOT EXISTS assembly_finished_at timestamptz;

-- Index supports the typical analytics queries: "average over the last
-- 30 days", "p95 over time", etc. Partial index keeps it small by only
-- including rows that actually completed.
CREATE INDEX IF NOT EXISTS idx_projects_assembly_finished_at
  ON projects (assembly_finished_at DESC)
  WHERE assembly_finished_at IS NOT NULL;
