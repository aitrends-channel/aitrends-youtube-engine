-- Add duration_sec to project_costs so we can compute per-second
-- cost from the kie_credits rows. Required for the video model
-- picker's "N cr/s" chip — without duration, units alone only tells
-- us total cost, not the per-second rate that lets users compare
-- models across different duration ranges.
--
-- Nullable on purpose: only the video_gen kie_credits step needs it,
-- and historical rows from before this migration don't have the data.
-- The picker's per-sec query filters duration_sec > 0 so historical
-- nulls are ignored — the displayed minimum converges to truth as
-- new generations land.
--
-- Frame-based models (e.g. sora-2-image-to-video where the duration
-- knob is n_frames, not seconds) should write NULL here — see the
-- worker's video_gen log call for the gate.

ALTER TABLE project_costs
  ADD COLUMN IF NOT EXISTS duration_sec NUMERIC;
