-- Persist the last prompts-generation failure.
--
-- The prompts step's error only ever lived in the client's React state, so
-- reloading the page lost it: the card fell back to its resumable label and
-- read "0 ready, first segment still processing" even though the run was
-- dead. A KIE outage therefore looked like healthy progress. Storing the
-- failure lets the page keep explaining it after a refresh.
--
-- prompts_last_error holds the ALREADY-FRIENDLY sentence (see
-- lib/errors/friendly.ts) because the page renders it verbatim; the raw
-- provider payload never reaches a customer. _step records which of the two
-- steps failed, since the run id is cleared on release and the page needs to
-- attach the message to the right card.
--
-- Cleared at the start of every new run (claimPromptsRun), so it only ever
-- describes the most recent attempt.

alter table projects
  add column if not exists prompts_last_error text,
  add column if not exists prompts_last_error_step text,
  add column if not exists prompts_last_error_at timestamptz;

comment on column projects.prompts_last_error is
  'Friendly text for the last failed prompts run; cleared when a new run is claimed.';
comment on column projects.prompts_last_error_step is
  'Which prompts step failed: images | videos.';
