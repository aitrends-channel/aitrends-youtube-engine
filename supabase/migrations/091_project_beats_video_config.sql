-- Per-beat video-generation config snapshot.
--
-- Until now the model / duration / aspect ratio / resolution used to
-- submit a beat to KIE lived only on the projects row (migrations 008
-- and 090). That's a race window: a user who queues 5 beats with
-- settings A and then flips to settings B and queues 3 more will see
-- the worker rewrite the first 5 with B, because the worker joins the
-- current projects row for every claim regardless of when the beat
-- was queued.
--
-- These four columns snapshot the chosen config at queue time onto
-- the beat row itself so the worker can prefer beat-owned values and
-- fall back to projects.* only when the beat columns are NULL (which
-- means the beat was queued before this migration). Nullability is
-- intentional — legacy rows and pre-migration queues stay valid.
--
-- video_duration is TEXT to mirror projects.video_duration (the
-- picker persists a string OR a number depending on the model's
-- durationKey; a text column captures both without a lossy cast).

ALTER TABLE project_beats
  ADD COLUMN IF NOT EXISTS video_model_id       TEXT,
  ADD COLUMN IF NOT EXISTS video_duration       TEXT,
  ADD COLUMN IF NOT EXISTS video_aspect_ratio   TEXT,
  ADD COLUMN IF NOT EXISTS video_resolution     TEXT;
