-- Admin control over the vision step: which model reads the frames, and how
-- many frames get sent.
--
-- Both were hardcoded. VISION_MODEL sat as a const in lib/claude/client.ts and
-- MAX_VIDEO_IMAGES as a local in the visual-analysis route, so the only way to
-- change either was a deploy — and the Model tab in Config → Anthropic never
-- affected the vision step at all, which was not obvious from the UI.
--
-- Why they belong together: image count and model price are the only two
-- levers on what this step costs, and they trade against each other. Frames
-- are the input-token driver (~1.6k tokens each), and the model sets the rate
-- those tokens bill at. Measured over 14 days of production traffic, visual
-- analysis ran 985,398 input and 155,535 output tokens: $8.82 on Opus 4.7,
-- $3.53 on Sonnet 5 at introductory pricing.
--
-- The picker offers two models (VISION_MODEL_IDS in lib/claude/vision.ts):
-- Opus 4.7 and Sonnet 5. Both are on the 2576px high-resolution tier and share
-- a tokenizer, so switching moves the rate and not the token count. Opus 5 and
-- 4.8 price identically to 4.7 and would add a choice without a decision;
-- Sonnet 4.6 caps at the older 1568px tier for the same list price as Sonnet 5;
-- Haiku 4.5's looser tool_choice adherence is a poor match for a step that
-- forces save_visual_analysis.
--
-- NULL or an unknown id falls back to the code default, same rule as
-- default_claude_model, so one bad value can't take the step down.

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS vision_model TEXT;

ALTER TABLE product_config
  ADD COLUMN IF NOT EXISTS visual_analysis_max_images INTEGER;

COMMENT ON COLUMN product_config.vision_model IS
  'Claude model id for the image-reading steps (visual analysis, prompts-from-image). NULL or unknown id = the code fallback in lib/claude/vision.ts.';

COMMENT ON COLUMN product_config.visual_analysis_max_images IS
  'How many frames the visual-analysis step sends per call. Applied per image list, so a call carrying both frames and thumbnails may send up to twice this. NULL or out of range = the code default.';
