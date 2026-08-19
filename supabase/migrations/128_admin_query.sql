-- Read-only SQL for the admin Query tab.
--
-- The Query tab lets an admin ask a question in prose and have the AI answer it
-- from the database. That needs real SELECT: every question worth asking so far
-- ("how much has this user spent at the prompts step", "which subscribers renew
-- this week") is an aggregate or a join, which the PostgREST client cannot
-- express.
--
-- Three layers stand between a generated query and the data, on the assumption
-- that each one will eventually fail:
--
--   1. The route validates the statement before it gets here: one statement,
--      SELECT or WITH only, no comments, no write keywords. See
--      app/api/admin/query/route.ts.
--   2. This function forces transaction_read_only, so anything that slipped
--      past the validator errors instead of writing. This is the layer that
--      does not depend on a regex being complete.
--   3. A statement timeout and a row cap, so a careless query cannot take the
--      database down or return a million rows into a prompt.
--
-- SECURITY INVOKER on purpose: the caller is already the service role, which
-- bypasses RLS, so DEFINER would add nothing but would let any future caller
-- inherit the owner's rights. Access control is requireAdmin in the route.

CREATE OR REPLACE FUNCTION admin_readonly_query(q text, row_cap int DEFAULT 500)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  result jsonb;
BEGIN
  -- Local to this transaction, so it cannot leak into anything else on the
  -- connection. A write inside q now raises
  -- "cannot execute INSERT in a read-only transaction".
  PERFORM set_config('transaction_read_only', 'on', true);
  PERFORM set_config('statement_timeout', '8s', true);

  -- The wrap does the row cap, so the model does not have to remember a LIMIT,
  -- and jsonb_agg gives the route one value to hand back rather than a dynamic
  -- row type it cannot describe in advance.
  EXECUTE format(
    'SELECT COALESCE(jsonb_agg(row_to_json(capped)), ''[]''::jsonb) FROM (SELECT * FROM (%s) AS q LIMIT %s) AS capped',
    q,
    GREATEST(1, LEAST(row_cap, 2000))
  ) INTO result;

  RETURN result;
END;
$$;

COMMENT ON FUNCTION admin_readonly_query(text, int) IS
  'Runs one read-only SELECT for the admin Query tab and returns the rows as jsonb. Forces transaction_read_only and an 8s statement timeout; caps rows at 2000. Callers must still validate the statement (app/api/admin/query/route.ts).';

-- The anon and authenticated roles must never reach this. Only the service role
-- the server uses, which is what the admin route holds.
REVOKE ALL ON FUNCTION admin_readonly_query(text, int) FROM PUBLIC;
REVOKE ALL ON FUNCTION admin_readonly_query(text, int) FROM anon;
REVOKE ALL ON FUNCTION admin_readonly_query(text, int) FROM authenticated;
