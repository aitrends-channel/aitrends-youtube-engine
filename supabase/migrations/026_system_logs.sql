-- Centralized structured log for system events (errors, warnings,
-- notable info). Catch blocks in workflow / generate / assemble routes
-- write here so the admin Logs tab has something to render beyond what
-- the projects table already shows (assembly errors).

CREATE TABLE IF NOT EXISTS system_logs (
  id          UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ  NOT NULL    DEFAULT now(),
  level       TEXT         NOT NULL    CHECK (level IN ('error', 'warn', 'info')),
  source      TEXT         NOT NULL,
  message     TEXT         NOT NULL,
  user_id     UUID,
  project_id  UUID,
  metadata    JSONB        NOT NULL    DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_system_logs_created_at ON system_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_level      ON system_logs (level);
CREATE INDEX IF NOT EXISTS idx_system_logs_source     ON system_logs (source);
