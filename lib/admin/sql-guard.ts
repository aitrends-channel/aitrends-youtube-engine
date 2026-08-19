// Validation for the SQL the admin Query tab's model writes.
//
// This is layer one of three. It is a regex over text, so it is the layer most
// likely to be incomplete: the database function forces transaction_read_only
// precisely so that a miss here fails closed rather than writing. Treat a change
// to this file as a change to a security boundary, and prefer refusing a query
// you are unsure about over letting it through.
//
// Refusals are returned as a reason rather than thrown, because the model reads
// them and rewrites the query. A vague message costs a round trip.

/** Statements that read. Anything else is refused outright. */
const ALLOWED_PREFIXES = ["select", "with"] as const;

/** Refused as whole words anywhere in the statement.
 *
 *  Some of these cannot write but are still out: pg_sleep holds a connection,
 *  pg_read_file and lo_import reach the filesystem, dblink and postgres_fdw
 *  reach other hosts, and set_config would undo the read-only guard below it. */
const FORBIDDEN = [
  "insert", "update", "delete", "drop", "alter", "truncate", "create", "replace",
  "grant", "revoke", "commit", "rollback", "savepoint", "vacuum", "analyze",
  "reindex", "cluster", "copy", "call", "do", "execute", "prepare", "listen",
  "notify", "lock", "set", "reset", "discard", "refresh", "comment", "security",
  "pg_sleep", "pg_read_file", "pg_read_binary_file", "pg_ls_dir", "lo_import",
  "lo_export", "dblink", "postgres_fdw", "pg_terminate_backend", "pg_cancel_backend",
  "set_config", "current_setting", "pg_authid", "pg_shadow",
];

export type SqlGuardResult =
  | { ok: true; sql: string }
  | { ok: false; reason: string };

/**
 * Accepts a single read-only statement, or explains why not.
 *
 * Comments are refused rather than stripped. `--` and slash-star are the usual
 * way a forbidden keyword gets smuggled past a word check, and an investigation
 * query has no need of them, so refusing costs nothing and removes the whole
 * class of problem.
 */
export function guardSql(raw: unknown): SqlGuardResult {
  if (typeof raw !== "string" || !raw.trim()) {
    return { ok: false, reason: "No SQL was provided." };
  }

  let sql = raw.trim();
  // One statement. A trailing semicolon is fine and common, anything after it
  // is a second statement.
  if (sql.endsWith(";")) sql = sql.slice(0, -1).trim();
  if (sql.includes(";")) {
    return { ok: false, reason: "Only one statement per query. Remove the semicolon and send a single SELECT." };
  }

  if (sql.includes("--") || sql.includes("/*") || sql.includes("*/")) {
    return { ok: false, reason: "Comments are not allowed. Send the statement without them." };
  }

  const lower = sql.toLowerCase();
  if (!ALLOWED_PREFIXES.some((p) => lower.startsWith(p))) {
    return { ok: false, reason: "Only SELECT (or WITH ... SELECT) is allowed." };
  }

  // Keyword scan runs against a copy with string literals blanked out. Without
  // that, a legitimate `WHERE topic ILIKE '%do%'` trips the "do" rule, and words
  // like set, copy and comment are common enough in real text to make the tab
  // feel broken. Blanking keeps the scan strict about SQL while ignoring data.
  const withoutLiterals = sql.replace(/'(?:''|[^'])*'/g, "''");

  // Word boundaries, so a column called "created_at" is not read as "create"
  // and "update_count" is not read as "update".
  for (const word of FORBIDDEN) {
    if (new RegExp(`\\b${word}\\b`, "i").test(withoutLiterals)) {
      return {
        ok: false,
        reason: `The word "${word}" is not allowed in a query here. This tab is read-only: use SELECT to look, and an admin action elsewhere to change anything.`,
      };
    }
  }

  // A WITH block can hold a data-modifying CTE, which the prefix check above
  // would happily accept. The keyword scan already covers it; this is the
  // explicit note for whoever reads this next and wonders.
  return { ok: true, sql };
}
