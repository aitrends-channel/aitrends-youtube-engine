#!/usr/bin/env bash
# =============================================================================
# Re-create dev auth.users from the orphan public-schema rows produced by the
# initial prod → dev pg_dump (which skipped the auth schema). Each new dev user
# keeps the SAME UUID as in prod, so the projects already in the dev DB tie
# back to them automatically. app_metadata + user_metadata are fetched from
# prod via the Auth admin API so plan/paid/is_admin gates behave identically.
#
# Run from the repo root after the dump+restore is complete. Idempotent —
# safe to re-run; users that already exist are skipped.
#
# Required env vars (export inline or put in a shell-sourced file; do NOT
# commit any of these values):
#
#   DEV_DB_PASSWORD              dev project's Postgres password (the one you
#                                set via "Reset password" on the dev project)
#   PROD_SUPABASE_URL            https://xpzrvvwkvyxpnaiorkvp.supabase.co
#   PROD_SUPABASE_SERVICE_ROLE_KEY  legacy service_role JWT from the prod
#                                project (Project Settings → API → Legacy
#                                API keys). Sensitive — unset after running.
#
# Reads the dev URL + dev service role from .env.local (which should already
# point at the dev project).
#
# Usage:
#   export DEV_DB_PASSWORD='…'
#   export PROD_SUPABASE_URL='https://xpzrvvwkvyxpnaiorkvp.supabase.co'
#   export PROD_SUPABASE_SERVICE_ROLE_KEY='eyJ…'
#   bash scripts/restore-dev-users.sh
#
# Dependencies: jq, curl, psql 17 (already installed for the dump step).
# =============================================================================

set -euo pipefail

# ── Load dev creds from .env.local ──────────────────────────────────────────
if [[ ! -f .env.local ]]; then
  echo "ERROR: .env.local not found. Run from the repo root." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1091
source .env.local
set +a

: "${NEXT_PUBLIC_SUPABASE_URL:?missing in .env.local}"
: "${SUPABASE_SERVICE_ROLE_KEY:?missing in .env.local}"
: "${DEV_DB_PASSWORD:?export DEV_DB_PASSWORD before running}"
: "${PROD_SUPABASE_URL:?export PROD_SUPABASE_URL before running}"
: "${PROD_SUPABASE_SERVICE_ROLE_KEY:?export PROD_SUPABASE_SERVICE_ROLE_KEY before running}"

# Safety check — make sure the user didn't accidentally point .env.local at
# prod. If they did, every "createUser" call would land in prod = disaster.
if [[ "${NEXT_PUBLIC_SUPABASE_URL}" == "${PROD_SUPABASE_URL}" ]]; then
  echo "ABORT: .env.local NEXT_PUBLIC_SUPABASE_URL matches PROD_SUPABASE_URL." >&2
  echo "Repoint .env.local at the dev project before running this script." >&2
  exit 1
fi

# ── Derive dev project ref + Postgres connection string ─────────────────────
DEV_REF="${NEXT_PUBLIC_SUPABASE_URL#https://}"
DEV_REF="${DEV_REF%%.supabase.co}"
DB_URL="postgresql://postgres.${DEV_REF}:${DEV_DB_PASSWORD}@aws-1-eu-central-2.pooler.supabase.com:5432/postgres"

PSQL="/usr/lib/postgresql/17/bin/psql"
if [[ ! -x "${PSQL}" ]]; then PSQL="psql"; fi

# Shared throwaway password — printed once so the admin can hand it out or
# trigger a recovery flow per-user later.
DEV_PASSWORD="dev-restore-$(date +%s)"
echo "→ Dev password for all restored users: ${DEV_PASSWORD}"
echo

# ── Fetch all prod users (paginated; per_page=1000 is the max) ─────────────
# Drop -f so a non-2xx still lets us inspect the response body. Capture the
# HTTP status separately so we can fail loudly with a useful message.
echo "→ Fetching prod user metadata…"
prod_http_status=$(curl -s -o /tmp/sb_prod_users.json -w "%{http_code}" \
  "${PROD_SUPABASE_URL}/auth/v1/admin/users?per_page=1000" \
  -H "apikey: ${PROD_SUPABASE_SERVICE_ROLE_KEY}" \
  -H "Authorization: Bearer ${PROD_SUPABASE_SERVICE_ROLE_KEY}")

if [[ "${prod_http_status}" != "200" ]]; then
  echo "ERROR: prod /auth/v1/admin/users returned HTTP ${prod_http_status}" >&2
  echo "Response body:" >&2
  cat /tmp/sb_prod_users.json >&2
  echo >&2
  echo "Common causes:" >&2
  echo "  401 + 'Invalid API key' → PROD_SUPABASE_SERVICE_ROLE_KEY is wrong" >&2
  echo "      (must be the legacy service_role JWT — starts with eyJhbGci...," >&2
  echo "       three dot-separated chunks. NOT the JWT signing secret.)" >&2
  echo "  403 → key is anon, not service_role" >&2
  echo "  404 → PROD_SUPABASE_URL typo'd" >&2
  exit 1
fi

prod_users_json=$(cat /tmp/sb_prod_users.json)

if ! echo "${prod_users_json}" | jq -e '.users' >/dev/null 2>&1; then
  echo "ERROR: prod returned 200 but response wasn't shaped like { users: [...] }:" >&2
  echo "${prod_users_json}" >&2
  exit 1
fi

prod_user_count=$(echo "${prod_users_json}" | jq '.users | length')
echo "→ Prod has ${prod_user_count} users"
echo

# ── Build the (user_id, email) list from PROD's auth.users ────────────────
# Source of truth is the prod auth list we just fetched — guaranteed to
# include every user who can sign in to prod, regardless of whether they
# ever created an account_settings row in dev. Using account_settings as
# the source would miss users without that row, and would also miss users
# whose email column happens to be NULL.
mapfile -t rows < <(echo "${prod_users_json}" | jq -r '
  .users[]
  | select(.email != null and .email != "")
  | "\(.id)|\(.email)"
')

created=0
skipped=0
failed=0

for row in "${rows[@]}"; do
  IFS='|' read -r uid email <<<"$row"
  [[ -z "${uid}" || -z "${email}" ]] && continue

  # Pull this user's app/user metadata out of the prod list.
  app_meta=$(echo "${prod_users_json}" | jq -c --arg id "${uid}" \
    '(.users[] | select(.id == $id) | .app_metadata) // {}')
  user_meta=$(echo "${prod_users_json}" | jq -c --arg id "${uid}" \
    '(.users[] | select(.id == $id) | .user_metadata) // {}')

  body=$(jq -n \
    --arg id    "${uid}" \
    --arg email "${email}" \
    --arg pw    "${DEV_PASSWORD}" \
    --argjson app  "${app_meta}" \
    --argjson usr  "${user_meta}" \
    '{
      id: $id,
      email: $email,
      password: $pw,
      email_confirm: true,
      app_metadata: $app,
      user_metadata: $usr
    }')

  status=$(curl -s -o /tmp/sb_resp.json -w "%{http_code}" \
    -X POST "${NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users" \
    -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
    -H "Content-Type: application/json" \
    -d "${body}")

  if [[ "${status}" == "200" || "${status}" == "201" ]]; then
    plan=$(echo "${app_meta}"  | jq -r '.plan      // "—"')
    paid=$(echo "${app_meta}"  | jq -r '.paid      // false')
    admn=$(echo "${app_meta}"  | jq -r '.is_admin  // false')
    printf "  created  %-32s  %s  plan=%s paid=%s admin=%s\n" \
      "${email}" "${uid}" "${plan}" "${paid}" "${admn}"
    # Use $((var+1)) — `((var++))` returns 0 on first increment from 0,
    # which `set -e` treats as failure and aborts the loop.
    created=$((created + 1))
  elif grep -q -iE 'already|duplicate' /tmp/sb_resp.json 2>/dev/null; then
    printf "  exists   %-32s  %s\n" "${email}" "${uid}"
    skipped=$((skipped + 1))
  else
    printf "  FAILED   %-32s  %s  status=%s  body=%s\n" \
      "${email}" "${uid}" "${status}" "$(tr -d '\n' </tmp/sb_resp.json)"
    failed=$((failed + 1))
  fi
done

echo
echo "Done. created=${created}, exists=${skipped}, failed=${failed}"
echo "Password for ALL restored users: ${DEV_PASSWORD}"
echo
echo "Next: unset PROD_SUPABASE_SERVICE_ROLE_KEY from your shell so it doesn't"
echo "linger in history. Then sign in on localhost:3000 as any restored user"
echo "using the password above — they'll see their original projects."
