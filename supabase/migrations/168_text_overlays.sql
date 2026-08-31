-- Text overlaid on the assembled video.
--
-- Its own table rather than a row in project_elements, even though the two
-- behave the same on the timeline. An element is a picture the worker ships
-- and refers to by name; a text is content the user typed, and it carries what
-- no element needs: the words, a colour and a treatment. Sharing one table
-- would mean half the columns null on every row.
--
-- Not captions. Captions are generated from the narration, styled once for the
-- whole video and timed by the transcript. A text is placed by hand, says
-- whatever it says, and is on screen for the span the person drew.
--
-- Times are seconds along the finished video, and position is a fraction of
-- the frame, both matching project_elements so the timeline can draw them on
-- the same axis. Size is a fraction of frame HEIGHT, unlike an element's
-- width: a font is specified by its height everywhere else in the world, and
-- ffmpeg's drawtext takes a pixel height.

CREATE TABLE IF NOT EXISTS project_texts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  start_sec   NUMERIC NOT NULL DEFAULT 0,
  end_sec     NUMERIC NOT NULL DEFAULT 3,
  x           NUMERIC NOT NULL DEFAULT 0.1,
  y           NUMERIC NOT NULL DEFAULT 0.1,
  /** Font height as a fraction of the frame height. */
  size        NUMERIC NOT NULL DEFAULT 0.06,
  colour      TEXT NOT NULL DEFAULT '#FFFFFF',
  -- plain    the glyphs alone
  -- outline  a dark stroke, for text over a bright or busy shot
  -- box      a translucent panel behind it, for a full line of copy
  style       TEXT NOT NULL DEFAULT 'outline',
  lane        INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A cap rather than a guess at what somebody might write. Long enough for a
  -- title card, short enough that one row cannot make a filtergraph the worker
  -- chokes on.
  CONSTRAINT project_texts_content_check CHECK (char_length(content) BETWEEN 1 AND 200),
  CONSTRAINT project_texts_style_check CHECK (style IN ('plain', 'outline', 'box')),
  -- #RGB or #RRGGBB, so the worker can hand it to ffmpeg without parsing it.
  CONSTRAINT project_texts_colour_check CHECK (colour ~* '^#[0-9a-f]{3}([0-9a-f]{3})?$'),
  CONSTRAINT project_texts_span_check CHECK (end_sec > start_sec AND start_sec >= 0),
  CONSTRAINT project_texts_lane_check CHECK (lane >= 0 AND lane <= 9),
  CONSTRAINT project_texts_place_check CHECK (
    x >= 0 AND x <= 1 AND y >= 0 AND y <= 1 AND size > 0 AND size <= 0.4
  )
);

-- The worker reads every text for one project, in draw order.
CREATE INDEX IF NOT EXISTS project_texts_project_idx
  ON project_texts (project_id, lane, start_sec);

COMMENT ON TABLE project_texts IS
  'Text overlaid on the assembled video: the words, when they are on screen, where, and how they are drawn.';
