-- Batched write for the three-step prompts flow's step 2 (fillPrompts).
--
-- That pass writes prompts onto beats that ALREADY exist, so it updates rows
-- instead of inserting them — the combined image pass inserts and needs no
-- helper. Five columns per beat, all distinct per row, so .in() can't collapse
-- them; without this a 200-beat project would issue 200 UPDATEs.
--
-- Same shape and reasoning as batch_update_beat_video_prompts (migration 082):
-- SECURITY DEFINER so the service-role client needs no per-column RLS carve-
-- out, every mutation scoped to p_project_id, and an UPDATE ... FROM (VALUES)
-- so an unknown beat_number matches zero rows rather than erroring.
--
-- Safe to apply immediately — additive, and nothing calls it until
-- PROMPTS_THREE_STEP is on. (Unlike migration 115, which must wait.)
--
-- Payload: [{ "beat_number": 1, "image_prompt": "...", "camera": "...",
--             "lighting": "...", "mood": "...", "action": "..." }, ...]

CREATE OR REPLACE FUNCTION batch_update_beat_image_prompts(
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
           x->>'image_prompt'           AS img,
           x->>'camera'                 AS cam,
           x->>'lighting'               AS lit,
           x->>'mood'                   AS mood,
           x->>'action'                 AS act
    FROM jsonb_array_elements(p_updates) AS x
  )
  UPDATE project_beats pb
     SET image_prompt = v.img,
         camera       = v.cam,
         lighting     = v.lit,
         mood         = v.mood,
         action       = v.act
    FROM v
   WHERE pb.project_id  = p_project_id
     AND pb.beat_number = v.bn;
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

REVOKE ALL ON FUNCTION batch_update_beat_image_prompts(UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION batch_update_beat_image_prompts(UUID, JSONB) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION batch_update_beat_image_prompts(UUID, JSONB) TO service_role;
