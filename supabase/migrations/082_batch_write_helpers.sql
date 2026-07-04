-- Batched-write helpers that collapse N per-row UPDATEs into a single
-- server round-trip. Motivated by the disk-IO audit that surfaced three
-- N+1 write patterns on hot paths:
--
--   1. video-worker's Stage-A durations pass — one UPDATE per beat to
--      persist duration_ms (~700 for a long project).
--   2. workflow/prompts video step — one UPDATE per beat per chunk to
--      persist video_prompt.
--   3. video-worker's per-beat completion — SELECT count(done) + UPDATE
--      projects.videos_progress after every beat commit, which also
--      grows quadratically with beats completed so far.
--
-- Each helper is SECURITY DEFINER so callers use the service-role client
-- without needing per-column RLS carve-outs. Every mutation is scoped to
-- the project_id passed in, and the UPDATE ... FROM (VALUES ...) shape
-- means an unknown beat_number just matches zero rows (safe no-op).
--
-- The updates argument uses JSONB so PostgREST can pass an untyped array
-- from JS without needing bespoke composite-type declarations.

-- ── batch_update_beat_durations ─────────────────────────────────────
-- Payload: [{ "beat_number": 1, "duration_ms": 1234 }, ...]
CREATE OR REPLACE FUNCTION batch_update_beat_durations(
  p_project_id UUID,
  p_updates    JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  WITH v AS (
    SELECT (x->>'beat_number')::INTEGER AS bn,
           (x->>'duration_ms')::INTEGER AS dur
    FROM jsonb_array_elements(p_updates) AS x
  )
  UPDATE project_beats pb
     SET duration_ms = v.dur
    FROM v
   WHERE pb.project_id  = p_project_id
     AND pb.beat_number = v.bn;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

-- ── batch_update_beat_video_prompts ─────────────────────────────────
-- Payload: [{ "beat_number": 1, "video_prompt": "..." }, ...]
CREATE OR REPLACE FUNCTION batch_update_beat_video_prompts(
  p_project_id UUID,
  p_updates    JSONB
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  WITH v AS (
    SELECT (x->>'beat_number')::INTEGER AS bn,
           x->>'video_prompt'          AS vp
    FROM jsonb_array_elements(p_updates) AS x
  )
  UPDATE project_beats pb
     SET video_prompt = v.vp
    FROM v
   WHERE pb.project_id  = p_project_id
     AND pb.beat_number = v.bn;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

-- ── increment_videos_progress ───────────────────────────────────────
-- Atomic +1 on projects.videos_progress. Returns the new value so the
-- caller can log it or send it to the UI. COALESCE guards NULL rows.
CREATE OR REPLACE FUNCTION increment_videos_progress(
  p_project_id UUID
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_val INTEGER;
BEGIN
  UPDATE projects
     SET videos_progress = COALESCE(videos_progress, 0) + 1
   WHERE id = p_project_id
  RETURNING videos_progress INTO new_val;
  RETURN new_val;
END;
$$;
