-- Six more treatments, from combining and steering what drawtext already does.
--
-- 171 said stroke and shadow were the ceiling, and that is still true of the
-- primitives. What was left unused is that a glyph can carry both at once, that
-- a shadow has a direction rather than only a distance, and that text has an
-- alpha.
--
--   poster       a stroke and a hard offset shadow together, the layered look
--   lift         shadow straight down, so the line sits above the picture
--   side         shadow to one side, no vertical drop
--   faded        the words at part opacity, for a watermark or a credit
--   glow-cool    a cyan halo, against the white and amber ones
--   edge-red     a red stroke, for text that has to be alarming
--
-- Fonts remain the real ceiling. Everything here is still one typeface.

ALTER TABLE project_texts
  DROP CONSTRAINT IF EXISTS project_texts_style_check;

ALTER TABLE project_texts
  ADD CONSTRAINT project_texts_style_check
  CHECK (style IN (
    'plain', 'outline', 'box', 'shadow', 'box-light', 'glow', 'heavy',
    'thin', 'outline-white', 'glow-warm', 'shadow-soft', 'shadow-hard',
    'poster', 'lift', 'side', 'faded', 'glow-cool', 'edge-red'
  ));
