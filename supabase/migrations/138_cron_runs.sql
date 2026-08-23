-- When each scheduled job last ran, and how it went.
--
-- Vercel knows the schedule and nothing else knows the outcome, so "did the
-- sweeper run last night" was answered by reading logs, and "when does the
-- reconciler fire next" by reading vercel.json and doing arithmetic. One row
-- per job, overwritten each run: this is a status board, not a history, and a
-- table that grows by ten rows a minute would need its own cleanup cron.
CREATE TABLE IF NOT EXISTS cron_runs (
  name           TEXT PRIMARY KEY,
  last_started_at  TIMESTAMPTZ,
  last_finished_at TIMESTAMPTZ,
  -- ok | error | running. "running" is what a row says between the two
  -- timestamps, which is also how a job that died mid-run is spotted.
  last_status    TEXT,
  -- One line about the run: what it swept, how many it finished, why it failed.
  last_detail    TEXT,
  -- Wall-clock of the last completed run, for spotting a job that is slowing
  -- down before it starts timing out.
  last_ms        INTEGER,
  runs           BIGINT NOT NULL DEFAULT 0,
  failures       BIGINT NOT NULL DEFAULT 0
);

COMMENT ON TABLE cron_runs IS
  'Last run of each scheduled job, written by stampCronRun in lib/cron/runs.ts and read by the admin Jobs tab. One row per job name, overwritten each run.';
