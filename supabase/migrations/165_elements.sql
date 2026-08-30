-- Elements: buttons overlaid on the video, each with its own span of time.
--
-- A table rather than columns on project_beats, because an element is not a
-- property of a beat. It starts and ends wherever the person putting it there
-- wants, which may be halfway through one beat and into the next, and a video
-- can carry several at once — a Subscribe in the corner while a Like flashes
-- in the middle.
--
-- Times are seconds along the finished video, the same axis the timeline
-- draws. Position and size are fractions of the frame, like the channel logo,
-- so they mean the same thing at every resolution.
--
-- The set ships with the worker and is drawn rather than sourced: every file
-- under assets/elements comes out of scripts/make-elements.sh.

CREATE TABLE IF NOT EXISTS project_elements (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  element     TEXT NOT NULL,
  start_sec   NUMERIC NOT NULL DEFAULT 0,
  end_sec     NUMERIC NOT NULL DEFAULT 3,
  x           NUMERIC NOT NULL DEFAULT 0.7,
  y           NUMERIC NOT NULL DEFAULT 0.1,
  size        NUMERIC NOT NULL DEFAULT 0.18,
  -- Which track it sits on. Chosen by dragging rather than derived from
  -- overlaps: the person placing them decides what is on top of what, and a
  -- layout that reshuffles itself when a block is nudged is not a layout.
  -- Higher lane draws over lower, the way a stack of tracks reads.
  lane        INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT project_elements_kind_check CHECK (element IN (
    'subscribe', 'subscribed', 'like', 'share', 'follow', 'comment', 'new', 'live'
  )),
  -- An element that ends before it starts would be drawn on nothing; one
  -- outside the frame would be drawn off it.
  CONSTRAINT project_elements_span_check CHECK (end_sec > start_sec AND start_sec >= 0),
  CONSTRAINT project_elements_lane_check CHECK (lane >= 0 AND lane <= 9),
  CONSTRAINT project_elements_place_check CHECK (
    x >= 0 AND x <= 1 AND y >= 0 AND y <= 1 AND size > 0 AND size <= 0.8
  )
);

-- Repair for a database that already has this table from an earlier run of
-- this file, where CREATE TABLE IF NOT EXISTS would skip it and leave the new
-- column missing. Every statement below is safe on a fresh table too.
ALTER TABLE project_elements ADD COLUMN IF NOT EXISTS lane INTEGER NOT NULL DEFAULT 0;
ALTER TABLE project_elements DROP CONSTRAINT IF EXISTS project_elements_lane_check;
ALTER TABLE project_elements ADD CONSTRAINT project_elements_lane_check CHECK (lane >= 0 AND lane <= 9);

-- The worker reads every element for one project, in time order.
CREATE INDEX IF NOT EXISTS project_elements_project_idx
  ON project_elements (project_id, lane, start_sec);

COMMENT ON TABLE project_elements IS
  'Buttons overlaid on the assembled video: which one, when it is on screen, and where.';
