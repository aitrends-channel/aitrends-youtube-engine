-- Editable bulk-mail templates. Until now the admin composer's template
-- presets were hardcoded in components/admin/BulkMailPanel.tsx; this
-- table makes them editable from the panel ("Save to template"). The
-- API (app/api/admin/bulk-mail/templates) falls back to the code
-- defaults when this table is missing or empty, so the app works
-- whether or not this migration has run yet.
--
-- Tokens supported in subject/body (substituted per recipient at send):
--   {{name}}  -> recipient's first name ("there" when unknown)
--   {{video}} -> "video"/"videos" by the recipient's matching count
--   {{stuck}} -> audience-aware sentence ("I noticed your video has
--                been stuck at the topic step for a while.")
--
-- video_table: whether the branded email appends the recipient's
-- stuck-videos table by default (admin can override per send).

CREATE TABLE IF NOT EXISTS bulk_mail_templates (
  id          TEXT        PRIMARY KEY,
  label       TEXT        NOT NULL,
  subject     TEXT        NOT NULL,
  body        TEXT        NOT NULL,
  video_table BOOLEAN     NOT NULL DEFAULT true,
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed with the current code defaults. ON CONFLICT DO NOTHING so
-- re-running never clobbers an admin's edits.
INSERT INTO bulk_mail_templates (id, label, subject, body, video_table, sort_order) VALUES
(
  'checkin',
  'Support check-in',
  'Checking in on your Heclus {{video}}',
  E'Hi {{name}},\n\nI''m Alex from the Heclus support team. {{stuck}}\n\nDid you run into any issues there? Just reply and let me know what got in the way. Happy to help you finish it.\n\nThanks,\nAlex\nHeclus Support',
  true,
  0
),
(
  'nudge',
  'Re-engagement nudge',
  'Your Heclus {{video}} is almost there',
  E'Hi {{name}},\n\nYour {{video}} is saved exactly where you left off - nothing is lost.\n\nMost videos take just a few more minutes to finish once the pipeline is running again. Jump back in and Heclus picks up from the step you stopped at.\n\nIf anything got in the way, just reply and I''ll help you through it.\n\nThanks,\nAlex\nHeclus Support',
  true,
  1
),
(
  'founder',
  'Founder offer',
  'A full year of Heclus for $40',
  E'Hi {{name}},\n\nSince you have a {{video}} in progress, I wanted to make sure you saw this before it''s gone: the Founder offer - a full year of Heclus for a one-time $40. Everything in Starter, 20 niches for the year, no monthly renewal.\n\nIt''s limited to the first 100 creators and spots are running low.\n\nYou can claim it at https://heclus.com/pricing.\n\nThanks,\nAlex\nHeclus Support',
  false,
  2
),
(
  'paid-no-setup',
  'Paid: finish account setup',
  'One step left to unlock your Heclus plan',
  E'Hi {{name}},\n\nThanks for joining Heclus - your plan is active, but your account setup isn''t finished yet, so none of it is working for you.\n\nIt''s one quick step: open the Setup page, add your API key (the page walks you through getting it), and you''re live. From there your first video is as simple as pasting a YouTube channel URL - the pipeline handles the script, voiceover, images, video clips, and thumbnails.\n\nIf anything about the setup is unclear, reply to this email and I''ll walk you through it personally. I read every response.\n\nThanks,\nAlex\nHeclus Support',
  false,
  3
),
(
  'paid-setup-no-video',
  'Paid: start first niche',
  'Your account is ready - your first video takes about two minutes',
  E'Hi {{name}},\n\nYour account is fully set up - the only thing missing is your first niche.\n\nHere''s all it takes: paste any YouTube channel URL and Heclus analyzes it, then generates the script, voiceover, images, video clips, and thumbnails for you. A couple of minutes of your time, and your plan starts earning its keep.\n\nNot sure which channel to start with? Reply with your topic and I''ll suggest a good niche to clone.\n\nThanks,\nAlex\nHeclus Support',
  false,
  4
)
ON CONFLICT (id) DO NOTHING;
