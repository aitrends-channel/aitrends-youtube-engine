-- More ways for a text overlay to be drawn.
--
-- 168 shipped three: the glyphs alone, a dark stroke, and a panel behind. Those
-- cover legibility and nothing else, so every overlay on a video looked the
-- same as every other one.
--
-- The four added here are the treatments ffmpeg's drawtext can actually do:
--   shadow      offset drop shadow, softer than a stroke
--   box-light   dark text on a light panel, for a label or a tag
--   glow        a wide, light stroke, which reads as a halo on dark footage
--   heavy       a thicker stroke than 'outline', for text over busy shots
--
-- Not a font list. Variety in an editor like CapCut is mostly typeface, and
-- the worker ships one face, so a preset naming a font it does not have would
-- render as the same face under a different name.
--
-- Widens the constraint rather than editing 168, which may already have run.

ALTER TABLE project_texts
  DROP CONSTRAINT IF EXISTS project_texts_style_check;

ALTER TABLE project_texts
  ADD CONSTRAINT project_texts_style_check
  CHECK (style IN ('plain', 'outline', 'box', 'shadow', 'box-light', 'glow', 'heavy'));
