-- Account-level usage rollup for the dashboard's "API keys & usage" tab.
--
-- Why a function instead of selecting the rows: project_costs is a per-call
-- ledger, so a single active account already holds tens of thousands of rows
-- (87k for the busiest dev account at 100k rows table-wide). Reading those
-- through PostgREST means ~90 paged requests to produce four numbers. The
-- aggregation belongs in the database; the route only shapes and zero-fills
-- what comes back.
--
-- Same vocabulary as /api/projects/[projectId]/costs: ledger steps roll up
-- into the nine display steps, and supadata is excluded because transcript
-- fetches are billed to us, not to the account.
--
-- Cache-read and cache-write tokens bill at different rates than plain input,
-- so "claudeTokens" is input + output only. Matches the Anthropic card's
-- 30-day figure in /api/api-status, which would otherwise disagree with the
-- usage section on the same screen.
--
-- Day buckets are UTC dates, so the daily series lines up with the window the
-- route zero-fills and rows near midnight are neither dropped nor counted
-- twice for callers in other timezones.

-- project_costs was only indexed on project_id, which is right for the
-- per-project view and useless here: every query below filters by user_id and
-- most also bound created_at.
CREATE INDEX IF NOT EXISTS idx_project_costs_user_created
  ON project_costs (user_id, created_at);

CREATE OR REPLACE FUNCTION user_usage_stats(uid UUID, window_days INTEGER DEFAULT 30)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
WITH src AS (
  SELECT
    pc.project_id,
    pc.created_at,
    pc.step,
    pc.unit_kind,
    pc.units,
    CASE pc.step
      WHEN 'channel_analysis'  THEN 'channel_analysis'
      WHEN 'topic'             THEN 'topic'
      WHEN 'script'            THEN 'script'
      WHEN 'visuals'           THEN 'visuals'
      WHEN 'prompts_image'     THEN 'prompts'
      WHEN 'prompts_video'     THEN 'prompts'
      WHEN 'tts'               THEN 'voiceover'
      WHEN 'image_gen'         THEN 'generate'
      WHEN 'video_gen'         THEN 'generate'
      WHEN 'assemble'          THEN 'assemble'
      WHEN 'thumbnail_concept' THEN 'thumbnail'
      WHEN 'thumbnail_image'   THEN 'thumbnail'
    END AS col,
    (pc.created_at AT TIME ZONE 'utc')::date
      >= ((now() AT TIME ZONE 'utc')::date - (GREATEST(window_days, 1) - 1)) AS recent
  FROM project_costs pc
  WHERE pc.user_id = uid
    AND pc.provider <> 'supadata'
),
-- Unmapped steps are dropped from every figure: a step the display doesn't
-- know about would inflate the totals without appearing in the breakdown.
mapped AS (
  SELECT * FROM src WHERE col IS NOT NULL
),
-- GROUPING SETS rather than two passes: the distinct video counts can't be
-- summed across partitions, so all-time has to be its own grouping.
totals AS (
  SELECT
    GROUPING(recent) AS g,
    recent,
    COALESCE(SUM(units) FILTER (WHERE unit_kind = 'kie_credits'), 0)      AS kie,
    COALESCE(SUM(units) FILTER (WHERE unit_kind = 'elevenlabs_chars'), 0) AS chars,
    COALESCE(SUM(units) FILTER (WHERE unit_kind IN ('claude_tokens_in', 'claude_tokens_out')), 0) AS tok,
    COUNT(DISTINCT project_id) AS videos,
    COUNT(DISTINCT project_id) FILTER (WHERE step IN ('image_gen', 'video_gen')) AS generated
  FROM mapped
  GROUP BY GROUPING SETS ((recent), ())
),
steps AS (
  SELECT
    GROUPING(recent) AS g,
    recent,
    col,
    COALESCE(SUM(units) FILTER (WHERE unit_kind = 'kie_credits'), 0)      AS kie,
    COALESCE(SUM(units) FILTER (WHERE unit_kind = 'elevenlabs_chars'), 0) AS chars,
    COALESCE(SUM(units) FILTER (WHERE unit_kind IN ('claude_tokens_in', 'claude_tokens_out')), 0) AS tok
  FROM mapped
  GROUP BY GROUPING SETS ((recent, col), (col))
),
daily AS (
  SELECT
    (created_at AT TIME ZONE 'utc')::date AS day,
    COALESCE(SUM(units) FILTER (WHERE unit_kind = 'kie_credits'), 0)      AS kie,
    COALESCE(SUM(units) FILTER (WHERE unit_kind = 'elevenlabs_chars'), 0) AS chars,
    COALESCE(SUM(units) FILTER (WHERE unit_kind IN ('claude_tokens_in', 'claude_tokens_out')), 0) AS tok
  FROM mapped
  WHERE recent
  GROUP BY 1
)
SELECT jsonb_build_object(
  'window', jsonb_build_object(
    'kieCredits',      COALESCE((SELECT kie       FROM totals WHERE g = 0 AND recent), 0),
    'elevenlabsChars', COALESCE((SELECT chars     FROM totals WHERE g = 0 AND recent), 0),
    'claudeTokens',    COALESCE((SELECT tok       FROM totals WHERE g = 0 AND recent), 0),
    'videos',          COALESCE((SELECT videos    FROM totals WHERE g = 0 AND recent), 0),
    'generated',       COALESCE((SELECT generated FROM totals WHERE g = 0 AND recent), 0),
    'steps', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'step', col, 'kieCredits', kie, 'elevenlabsChars', chars, 'claudeTokens', tok))
      FROM steps WHERE g = 0 AND recent
    ), '[]'::jsonb)
  ),
  'all', jsonb_build_object(
    'kieCredits',      COALESCE((SELECT kie       FROM totals WHERE g = 1), 0),
    'elevenlabsChars', COALESCE((SELECT chars     FROM totals WHERE g = 1), 0),
    'claudeTokens',    COALESCE((SELECT tok       FROM totals WHERE g = 1), 0),
    'videos',          COALESCE((SELECT videos    FROM totals WHERE g = 1), 0),
    'generated',       COALESCE((SELECT generated FROM totals WHERE g = 1), 0),
    'steps', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'step', col, 'kieCredits', kie, 'elevenlabsChars', chars, 'claudeTokens', tok))
      FROM steps WHERE g = 1
    ), '[]'::jsonb)
  ),
  'daily', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'date', to_char(day, 'YYYY-MM-DD'), 'kieCredits', kie, 'elevenlabsChars', chars, 'claudeTokens', tok)
      ORDER BY day)
    FROM daily
  ), '[]'::jsonb),
  'since', (SELECT MIN(created_at) FROM src)
);
$$;

COMMENT ON FUNCTION user_usage_stats(UUID, INTEGER) IS
  'Usage rollup for one account from project_costs: totals, per-step breakdown and a per-UTC-day series for the last window_days, plus all-time totals. Raw provider units (KIE credits, ElevenLabs characters, Claude input+output tokens); supadata excluded.';
