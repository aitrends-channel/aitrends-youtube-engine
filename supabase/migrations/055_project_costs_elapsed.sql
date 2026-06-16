-- Add elapsed_ms to project_costs so the picker's "Fastest" tab can
-- rank models by observed wall-clock generation time. Wall-clock
-- captures the experience that matters to the user — submit click
-- through to image-ready — including KIE-side queueing, which a
-- pure model-speed benchmark would miss.
--
-- Nullable on purpose: only the kie_credits rows currently set it
-- (image_gen and, later, video_gen). Other steps (claude tokens,
-- elevenlabs chars) leave it null. The picker's ranking query
-- filters elapsed_ms > 0 so nulls are ignored.
--
-- Stored in milliseconds because images often complete in well
-- under a second and rounding to seconds would lose ordering between
-- e.g. a 400ms model and an 800ms one.

ALTER TABLE project_costs
  ADD COLUMN IF NOT EXISTS elapsed_ms NUMERIC;
