/*
  Persist user-selected background music and channel logo for the
  assemble step. Until now both lived only in React state on the
  assemble page and in the short-lived Redis assembly:{projectId} key
  (2-hour TTL, deleted by the worker once it dequeues), so a page
  refresh between picking the files and clicking Assemble (or after
  Stop and before Resume) wiped the selection and the resumed
  assembly silently rendered with no music or logo.

  The file binaries are already uploaded to R2 by /api/upload under
  {userFolder}/{projectId}/background-music/ and .../channel-logo/.
  This migration stores the public R2 URLs plus the position, volume,
  and size settings on the project row so the assemble page can
  hydrate them on next load.

  All six columns are nullable or default to the same fallback values
  the worker uses when the field is missing, so existing rows continue
  to behave exactly as before.
*/
ALTER TABLE projects ADD COLUMN IF NOT EXISTS background_music_url    TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS background_music_volume NUMERIC DEFAULT 0.15;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS logo_url                TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS logo_x                  NUMERIC DEFAULT 0.85;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS logo_y                  NUMERIC DEFAULT 0.05;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS logo_size               NUMERIC DEFAULT 0.1;
