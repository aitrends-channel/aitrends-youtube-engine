-- Merging beats left the survivor holding a prompt written for its OLD,
-- shorter segment.
--
-- Merge beat 7 into beat 6 and beat 6's script_segment becomes 6+7, but its
-- image_prompt still describes only the first half. The image then illustrates
-- part of what is narrated over it. Beat 7's own prompt is discarded by the
-- delete, so the paid-for work is lost either way.
--
-- The prompt fields are DERIVED from script_segment, exactly like the timings
-- this function already nulls (start/end/duration, because the old boundaries
-- no longer apply) and exactly like voiceover, which the segment hash already
-- marks stale. Prompts had neither mechanism and were simply missed.
--
-- Nulling them makes the beat read as "needs a prompt", which the prompts step
-- picks up and rewrites against the merged text. That costs one beat's prompt
-- (~0.4 credits at observed rates) instead of leaving wrong text in place.
--
-- Done inside the function rather than as a follow-up UPDATE in the route for
-- the same reason the renumber is: this has to be atomic. A second statement
-- that could fail would leave precisely the mismatch being removed here.
--
-- image_url / video_url are deliberately LEFT ALONE. Those are already-paid
-- renders and image generation is ~86% of what users spend; discarding one to
-- fix a text inconsistency is the wrong trade, and a still held over slightly
-- longer narration is usually fine. The caller surfaces the beat instead.

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

  -- Timings AND prompts describe the old, shorter segment. Both are derived,
  -- so both are invalidated here.
  UPDATE project_beats
     SET script_segment = p_segment,
         start_time_ms  = NULL,
         end_time_ms    = NULL,
         duration_ms    = NULL,
         image_prompt   = NULL,
         video_prompt   = NULL,
         camera         = NULL,
         lighting       = NULL,
         mood           = NULL,
         action         = NULL
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
