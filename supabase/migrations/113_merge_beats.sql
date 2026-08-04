-- Merge two adjacent beats into one, for the prompts step: the script
-- splitter sometimes emits a beat holding one or two words, which is not
-- worth an image and a clip of its own.
--
-- Atomic on purpose. The renumber that follows the delete has to either
-- happen completely or not at all — a half-renumbered project has
-- duplicate or gapped beat_numbers, and the assembler reads beats by
-- order, so it would silently render the wrong sequence.
--
-- The renumber goes via a +1e6 offset rather than a single
-- `beat_number - 1`: UNIQUE(project_id, beat_number) is checked per row
-- and UPDATE has no ORDER BY, so a straight decrement can collide with a
-- row Postgres hasn't moved yet. Both offset passes are collision-free.
--
-- Prompts, camera/lighting/mood/action and media stay with the SURVIVING
-- (lower-numbered) beat; the absorbed row's asset URLs are returned so
-- the caller can delete the now-orphaned R2 objects. voiceover_url is
-- deliberately left alone — the longer script_segment no longer matches
-- voiceover_script_hash, which is exactly how every other script edit
-- marks audio stale (see beats/dedupe-overlap).

-- SECURITY DEFINER like the 082 helpers, but locked to service_role: this
-- one deletes a row, and PostgREST exposes functions to `authenticated` by
-- default, which would let any signed-in user destroy beats in a project
-- they only had to guess the id of. Ownership is checked in the route.

CREATE OR REPLACE FUNCTION merge_project_beats(
  p_project_id UUID,
  p_keep       INTEGER,
  p_absorb     INTEGER,
  p_segment    TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  orphan_image     TEXT;
  orphan_video     TEXT;
  orphan_voiceover TEXT;
  remaining        INTEGER;
BEGIN
  IF p_absorb <> p_keep + 1 THEN
    RAISE EXCEPTION 'beats must be adjacent (keep=%, absorb=%)', p_keep, p_absorb;
  END IF;

  SELECT image_url, video_url, voiceover_url
    INTO orphan_image, orphan_video, orphan_voiceover
    FROM project_beats
   WHERE project_id = p_project_id AND beat_number = p_absorb;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'beat % not found', p_absorb;
  END IF;

  -- Timings describe the old boundaries, so drop them; the assembler
  -- recomputes on the next run.
  UPDATE project_beats
     SET script_segment = p_segment,
         start_time_ms  = NULL,
         end_time_ms    = NULL,
         duration_ms    = NULL
   WHERE project_id = p_project_id AND beat_number = p_keep;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'beat % not found', p_keep;
  END IF;

  DELETE FROM project_beats
   WHERE project_id = p_project_id AND beat_number = p_absorb;

  UPDATE project_beats SET beat_number = beat_number + 1000000
   WHERE project_id = p_project_id AND beat_number > p_absorb;
  UPDATE project_beats SET beat_number = beat_number - 1000001
   WHERE project_id = p_project_id AND beat_number > 1000000;

  SELECT count(*) INTO remaining
    FROM project_beats WHERE project_id = p_project_id;

  RETURN jsonb_build_object(
    'kept_beat_number', p_keep,
    'remaining_beats',  remaining,
    'orphan_image_url',     orphan_image,
    'orphan_video_url',     orphan_video,
    'orphan_voiceover_url', orphan_voiceover
  );
END;
$$;

REVOKE ALL ON FUNCTION merge_project_beats(UUID, INTEGER, INTEGER, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION merge_project_beats(UUID, INTEGER, INTEGER, TEXT) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION merge_project_beats(UUID, INTEGER, INTEGER, TEXT) TO service_role;
