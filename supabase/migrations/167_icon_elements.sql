-- Ten more elements: marks rather than words.
--
-- 165 shipped eight, all of them a pill with a word on it. A word only works
-- in one language and only for an action; the thing people actually put in a
-- corner is a mark. These are a bell, six platform logos, and the two actions
-- that are a shape rather than a word.
--
-- Each is white on a rounded tile in the platform's own colour, drawn by the
-- worker's scripts/make-elements.sh. Unlike the buttons, the logos are not
-- drawn from nothing: a mark reproduced by hand is a mark reproduced slightly
-- wrong, so the sources are vendored under assets/elements/svg and rasterised.
-- Provenance and terms are recorded in assets/elements/LICENSES.md.
--
-- Widens the constraint rather than editing 165, which may already have run.

ALTER TABLE project_elements
  DROP CONSTRAINT IF EXISTS project_elements_kind_check;

ALTER TABLE project_elements
  ADD CONSTRAINT project_elements_kind_check
  CHECK (element IN (
    'subscribe', 'subscribed', 'like', 'share', 'follow', 'comment', 'new', 'live',
    'bell', 'bell-ring',
    'youtube', 'instagram', 'tiktok', 'facebook', 'x', 'whatsapp',
    'heart', 'thumbs-up'
  ));
