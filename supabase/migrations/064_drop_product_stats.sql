-- Roll back the product_stats counter table introduced in 063.
-- The table was scaffolded but never wired up to the admin Stats
-- section (the live aggregation in /api/admin/stats is the source of
-- truth, and a parallel counter would just be another thing to keep
-- in sync). Dropping it before launch to avoid carrying dead schema
-- + triggers into prod.
--
-- All statements use IF EXISTS so the migration is safe to apply on
-- an environment where 063 was never run.

DROP TRIGGER IF EXISTS product_stats_project_insert ON projects;
DROP TRIGGER IF EXISTS product_stats_project_done   ON projects;

DROP FUNCTION IF EXISTS product_stats_on_project_insert();
DROP FUNCTION IF EXISTS product_stats_on_project_done();

DROP TABLE IF EXISTS product_stats;
