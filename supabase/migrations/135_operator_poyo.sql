-- Admit PoYo as a third operator.
--
-- Migration 134 deliberately made the allowed set a check constraint rather
-- than free text, so adding a provider is a visible schema event. This is that
-- event, and it is the whole cost of it.
--
-- Both surfaces. Images are submitted by youtube-engine, video by video-worker
-- (src/lib/poyoVideos.ts), and both stamp the operator alongside the task id.
-- genaipro stays valid on video only: it is the free lane and has no image path.

ALTER TABLE project_beats DROP CONSTRAINT IF EXISTS project_beats_image_operator_check;
ALTER TABLE project_beats ADD CONSTRAINT project_beats_image_operator_check
  CHECK (image_operator IN ('kie', 'poyo'));

ALTER TABLE project_beats DROP CONSTRAINT IF EXISTS project_beats_video_operator_check;
ALTER TABLE project_beats ADD CONSTRAINT project_beats_video_operator_check
  CHECK (video_operator IN ('kie', 'genaipro', 'poyo'));
