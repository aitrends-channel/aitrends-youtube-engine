-- Backfill script: trim leading text on each beat that duplicates the
-- previous beat's ending. Mirrors lib/text/dedupeOverlap.ts in pl/pgsql.
--
-- USAGE: Copy these three sections into the Supabase SQL editor.
--   1) Create the dedupe_overlap() function (idempotent, safe to re-run).
--   2) Run the dry-run SELECT to see exactly what would change.
--   3) Run the UPDATE block once you're happy with the dry-run output.
--
-- Audio files are NOT touched. The voiceover_script_hash mismatch left
-- after this fix marks affected beats as stale on the next bulk Generate
-- run; the user decides when to regenerate audio for the cleaned text.

-- ─── 1. FUNCTION ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION dedupe_overlap(p_current TEXT, p_previous TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  stopwords TEXT[] := ARRAY[
    'the','a','an','and','or','but','so','of','to','in','on','at','by',
    'for','with','from','as','is','it','its','he','she','we','i','you',
    'they','them','us','was','were','are','be','been','has','had','have',
    'do','did','does','this','that','these','those','if','then','than',
    'when','while','yet','not','no'
  ];
  cur_words  TEXT[];
  prev_words TEXT[];
  cur_norm   TEXT[];
  prev_norm  TEXT[];
  max_k      INT;
  k          INT;
  is_match   BOOLEAN;
  i          INT;
  trimmed    TEXT;
  prev_tail  TEXT[];
  cur_head   TEXT[];
  one_word   TEXT;
  cur_len    INT;
  prev_len   INT;
BEGIN
  IF p_previous IS NULL OR length(btrim(p_previous)) = 0 THEN
    RETURN p_current;
  END IF;

  cur_words  := regexp_split_to_array(btrim(p_current),  '\s+');
  prev_words := regexp_split_to_array(btrim(p_previous), '\s+');

  cur_len  := COALESCE(array_length(cur_words,  1), 0);
  prev_len := COALESCE(array_length(prev_words, 1), 0);
  IF cur_len = 0 OR prev_len = 0 THEN RETURN p_current; END IF;

  -- Normalize: lowercase + strip non-alphanumeric. This is what makes
  -- "Slow," == "slow" for comparison.
  cur_norm  := ARRAY(SELECT lower(regexp_replace(w, '[^[:alnum:]]', '', 'g'))
                     FROM unnest(cur_words)  AS w);
  prev_norm := ARRAY(SELECT lower(regexp_replace(w, '[^[:alnum:]]', '', 'g'))
                     FROM unnest(prev_words) AS w);

  max_k := LEAST(cur_len, prev_len, 12);

  FOR k IN REVERSE max_k..1 LOOP
    prev_tail := prev_norm[(prev_len - k + 1) : prev_len];
    cur_head  := cur_norm[1 : k];

    is_match := TRUE;
    FOR i IN 1..k LOOP
      IF prev_tail[i] IS NULL
         OR prev_tail[i] = ''
         OR prev_tail[i] <> cur_head[i]
      THEN
        is_match := FALSE;
        EXIT;
      END IF;
    END LOOP;

    IF is_match THEN
      -- At K=1, require a non-stopword of length >= 3 so we don't
      -- over-trim coincidental connectors like "the / the".
      IF k = 1 THEN
        one_word := prev_tail[1];
        IF length(one_word) < 3 OR one_word = ANY(stopwords) THEN
          CONTINUE;
        END IF;
      END IF;

      -- Safety net: never return an empty string. Better to ship the
      -- (already-spoken) repeat than complete silence.
      IF k >= cur_len THEN
        RETURN p_current;
      END IF;
      trimmed := array_to_string(cur_words[(k + 1) : cur_len], ' ');
      RETURN trimmed;
    END IF;
  END LOOP;

  RETURN p_current;
END;
$$;


-- ─── 2. DRY RUN — review before applying ────────────────────────────
-- Lists every beat that WOULD be changed. Add a WHERE project_id = '…'
-- clause if you only want to preview a single project.
WITH ordered AS (
  SELECT
    project_id,
    beat_number,
    script_segment,
    LAG(script_segment) OVER (PARTITION BY project_id ORDER BY beat_number) AS prev_segment
  FROM project_beats
)
SELECT
  project_id,
  beat_number,
  LEFT(script_segment, 80)                                            AS before_text,
  LEFT(dedupe_overlap(script_segment, prev_segment), 80)              AS after_text,
  length(script_segment) - length(dedupe_overlap(script_segment, prev_segment)) AS chars_removed
FROM ordered
WHERE dedupe_overlap(script_segment, prev_segment) IS DISTINCT FROM script_segment
ORDER BY project_id, beat_number;


-- ─── 3. APPLY — commit the cleaned segments to the DB ───────────────
-- Once the dry-run output looks right, run this block. Same WHERE
-- clause trick: add `AND pb.project_id = '…'` to limit to one project.
WITH ordered AS (
  SELECT
    project_id,
    beat_number,
    script_segment,
    LAG(script_segment) OVER (PARTITION BY project_id ORDER BY beat_number) AS prev_segment
  FROM project_beats
),
to_update AS (
  SELECT
    project_id,
    beat_number,
    dedupe_overlap(script_segment, prev_segment) AS new_text
  FROM ordered
  WHERE dedupe_overlap(script_segment, prev_segment) IS DISTINCT FROM script_segment
)
UPDATE project_beats AS pb
SET    script_segment = u.new_text
FROM   to_update AS u
WHERE  pb.project_id  = u.project_id
  AND  pb.beat_number = u.beat_number
RETURNING pb.project_id, pb.beat_number, LEFT(pb.script_segment, 80) AS new_preview;
