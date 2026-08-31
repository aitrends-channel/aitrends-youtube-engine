-- Sounds placed on the timeline, rather than attached to a beat.
--
-- project_beats.sound_effect puts a sound at the start of a beat, which is the
-- right default and the wrong only option: an accent often belongs a second
-- into a shot, or between two of them, and a beat has one slot so a second
-- sound in the same shot is impossible.
--
-- Additive. Beat sounds keep working exactly as they did and the worker mixes
-- both into one bed, because they are the same thing arriving two ways: a cue
-- at a time, at a level and a pitch. Nothing is migrated, so a project that
-- never opens this table behaves as it always has.
--
-- at_sec is seconds along the finished video, like project_elements and
-- project_texts, so one timeline draws all three on the same axis.

CREATE TABLE IF NOT EXISTS project_sounds (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sound       TEXT NOT NULL,
  at_sec      NUMERIC NOT NULL DEFAULT 0,
  /** Relative to the project's sfx_volume, which stays the master. */
  volume      NUMERIC NOT NULL DEFAULT 1,
  /** Playback-rate shift with the speed put back, so a higher click is still a
   *  click rather than a shorter one. */
  pitch       NUMERIC NOT NULL DEFAULT 1,
  lane        INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- The same set project_beats.sound_effect allows, and for the same reason:
  -- the ids are filenames under the worker's assets/sfx.
  CONSTRAINT project_sounds_kind_check CHECK (sound IN (
    'whoosh', 'reverse-whoosh', 'swish', 'sweep', 'page',
    'click', 'tick', 'pop', 'beep', 'glitch', 'shutter',
    'zoom-in', 'zoom-out', 'riser',
    'impact', 'boom', 'thud', 'heartbeat',
    'chime', 'ding', 'sparkle',
    'bell', 'notification', 'alert'
  )),
  CONSTRAINT project_sounds_at_check CHECK (at_sec >= 0),
  CONSTRAINT project_sounds_volume_check CHECK (volume >= 0 AND volume <= 2),
  CONSTRAINT project_sounds_pitch_check CHECK (pitch >= 0.5 AND pitch <= 2),
  CONSTRAINT project_sounds_lane_check CHECK (lane >= 0 AND lane <= 9)
);

CREATE INDEX IF NOT EXISTS project_sounds_project_idx
  ON project_sounds (project_id, at_sec);

COMMENT ON TABLE project_sounds IS
  'Sound effects placed at a moment on the finished video, alongside the per-beat ones.';
