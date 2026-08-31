-- Five more treatments.
--
-- 169 left the style column meaning "how the glyphs are drawn" and offered
-- five ways. These are the rest of what ffmpeg's drawtext can actually do to a
-- glyph: a stroke can be thinner, heavier, or a colour other than black, and a
-- shadow can sit closer, further, or harder.
--
--   thin           a light stroke, for text already sitting on a panel
--   outline-white  a white stroke, which is what dark text needs over dark shots
--   glow-warm      an amber halo, warmer than the white one
--   shadow-soft    a close, faint shadow, barely a lift off the picture
--   shadow-hard    a long, solid shadow, the offset kind a poster uses
--
-- Still not a font list, and this is where that ceiling sits: everything a
-- style can say here is stroke and shadow, because the worker ships one face.
-- More variety than this means shipping fonts, not widening this constraint.

ALTER TABLE project_texts
  DROP CONSTRAINT IF EXISTS project_texts_style_check;

ALTER TABLE project_texts
  ADD CONSTRAINT project_texts_style_check
  CHECK (style IN (
    'plain', 'outline', 'box', 'shadow', 'box-light', 'glow', 'heavy',
    'thin', 'outline-white', 'glow-warm', 'shadow-soft', 'shadow-hard'
  ));
