-- Negative-cache extension for transcript_cache.
--
-- Supadata bills 1 credit per video in a batch regardless of outcome
-- (no captions, errorCode set, etc.). Today we only memoize successes,
-- so every re-analysis of a channel with caption-less videos costs us
-- a credit per failure, repeatedly.
--
-- This adds:
--   success      -- false for known-no-transcript videos
--   error_code   -- Supadata's error code on failure, for diagnostics
--
-- text and word_count become nullable so failure rows can be stored
-- without dummy values. cached_at is repurposed as "last attempt time"
-- — explicitly set on every upsert. Failure rows are returned to
-- callers only when within a freshness TTL (enforced in app code) so
-- videos that eventually get captions still get re-tried.

ALTER TABLE transcript_cache
  ALTER COLUMN text DROP NOT NULL,
  ALTER COLUMN word_count DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS success boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS error_code text;
