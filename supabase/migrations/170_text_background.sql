-- A background a person can choose, rather than one baked into a style.
--
-- 168 and 169 offered 'box' and 'box-light', which are a black panel at 55%
-- and a white one at 85%. Those are two points in a space, and the two things
-- somebody actually wants to change about a panel are its colour and how much
-- of the shot it hides. Neither was reachable.
--
-- So the panel becomes its own pair of columns and the style column goes back
-- to meaning only how the glyphs are drawn. NULL bg_colour is no panel, which
-- is why it is nullable rather than defaulted: "no background" and "a
-- transparent background" would otherwise be the same row.
--
-- The two old styles are converted rather than dropped. They stay legal in the
-- constraint so a worker deployed before this migration still renders a row it
-- wrote, and the worker treats them as the panels they always were.

ALTER TABLE project_texts
  ADD COLUMN IF NOT EXISTS bg_colour TEXT;

ALTER TABLE project_texts
  ADD COLUMN IF NOT EXISTS bg_opacity NUMERIC NOT NULL DEFAULT 0.55;

ALTER TABLE project_texts
  DROP CONSTRAINT IF EXISTS project_texts_bg_colour_check;
ALTER TABLE project_texts
  ADD CONSTRAINT project_texts_bg_colour_check
  CHECK (bg_colour IS NULL OR bg_colour ~* '^#[0-9a-f]{3}([0-9a-f]{3})?$');

ALTER TABLE project_texts
  DROP CONSTRAINT IF EXISTS project_texts_bg_opacity_check;
ALTER TABLE project_texts
  ADD CONSTRAINT project_texts_bg_opacity_check
  CHECK (bg_opacity >= 0 AND bg_opacity <= 1);

-- What the two styles meant, written into the columns that now mean it.
UPDATE project_texts
   SET bg_colour = '#000000', bg_opacity = 0.55, style = 'plain'
 WHERE style = 'box' AND bg_colour IS NULL;

UPDATE project_texts
   SET bg_colour = '#FFFFFF', bg_opacity = 0.85, style = 'plain'
 WHERE style = 'box-light' AND bg_colour IS NULL;

COMMENT ON COLUMN project_texts.bg_colour IS
  'Panel behind the text. NULL is no panel; the opacity beside it says how solid.';
