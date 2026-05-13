-- Fix video URLs that were saved with the wrong storage bucket name.
-- Files are in 'assets' but getPublicUrl was called with 'media'.
UPDATE project_beats
SET video_url = replace(video_url, '/object/public/media/', '/object/public/assets/')
WHERE video_url LIKE '%/object/public/media/%';
