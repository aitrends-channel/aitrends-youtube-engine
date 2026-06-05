-- Tracks the script content that the saved tts_url was generated from.
-- Lets the UI detect "voiceover is stale because the script was edited
-- after generation" without comparing the full text in the browser.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tts_script_hash TEXT;
