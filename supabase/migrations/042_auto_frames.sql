-- Persist the auto-captured channel frame stills so the visuals page
-- can restore the fetched grid across browser refreshes. Previously
-- the screenshots route uploaded the frames to R2 but returned the
-- URLs purely to React state, so a reload wiped the visible
-- thumbnails even though the underlying assets were still in storage.
-- Shape:
--   [{ videoId: string, title: string, thumbnailUrl: string, frameUrls: string[] }]
ALTER TABLE projects ADD COLUMN IF NOT EXISTS auto_frames JSONB;
