-- Persistent counter for the admin Stats section. Columns mirror the
-- AdminStats interface in app/admin/page.tsx so the admin endpoint
-- can stop recomputing these from full-table scans of projects /
-- auth.users on every dashboard load.
--
-- Singleton table — PK is hardcoded id=1 with a CHECK constraint so
-- only one row can ever exist. All counters default to 0; an admin
-- "Launch" action can reset them to 0 to start fresh from the
-- production switchover.
--
-- Triggers handle the two events the launch counters care about:
--   - project INSERT → total_projects++ and videos_in_progress++
--   - project assembly_status transition to 'done' → completed++
--     and videos_in_progress-- (clamped at 0)
--
-- access_granted and active_accounts stay at 0 until separately
-- wired — they're user-level and aren't driven by project events.

CREATE TABLE IF NOT EXISTS product_stats (
  id                   INTEGER     PRIMARY KEY DEFAULT 1,
  access_granted       INTEGER     NOT NULL DEFAULT 0,
  active_accounts      INTEGER     NOT NULL DEFAULT 0,
  total_projects       INTEGER     NOT NULL DEFAULT 0,
  completed            INTEGER     NOT NULL DEFAULT 0,
  videos_in_progress   INTEGER     NOT NULL DEFAULT 0,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT product_stats_singleton CHECK (id = 1)
);

-- Seed the one-and-only row. Idempotent on re-run.
INSERT INTO product_stats (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ── Trigger: project INSERT → bump total_projects + in-progress ──
CREATE OR REPLACE FUNCTION product_stats_on_project_insert()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE product_stats
     SET total_projects     = total_projects + 1,
         videos_in_progress = videos_in_progress + 1,
         updated_at         = now()
   WHERE id = 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_stats_project_insert ON projects;
CREATE TRIGGER product_stats_project_insert
  AFTER INSERT ON projects
  FOR EACH ROW EXECUTE FUNCTION product_stats_on_project_insert();

-- ── Trigger: project assembly_status transitions to 'done' ─────────
-- Fires only on the test-to-done edge so a re-save of a row that's
-- already done doesn't double-count.
CREATE OR REPLACE FUNCTION product_stats_on_project_done()
RETURNS TRIGGER AS $$
BEGIN
  IF (OLD.assembly_status IS DISTINCT FROM 'done')
     AND (NEW.assembly_status = 'done') THEN
    UPDATE product_stats
       SET completed          = completed + 1,
           videos_in_progress = GREATEST(videos_in_progress - 1, 0),
           updated_at         = now()
     WHERE id = 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS product_stats_project_done ON projects;
CREATE TRIGGER product_stats_project_done
  AFTER UPDATE OF assembly_status ON projects
  FOR EACH ROW EXECUTE FUNCTION product_stats_on_project_done();
