-- Supabase advisor: founder_claims_log is in the public schema (so
-- PostgREST exposes it) but RLS was never enabled. Fix by turning it
-- on with no user-facing policies — the only legitimate access paths
-- are the claim_founder_spot RPC and the admin reset-founder-slots
-- route, both running under service_role (which bypasses RLS by
-- default), so no policies are required for them to keep working.
--
-- Net effect: anon/authenticated cannot SELECT/INSERT/UPDATE/DELETE
-- this table via PostgREST anymore. Service-role paths unchanged.

ALTER TABLE founder_claims_log ENABLE ROW LEVEL SECURITY;
