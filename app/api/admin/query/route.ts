import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";
import { getHeclusDirectClient } from "@/lib/claude/client";
import { resolveDefaultModel } from "@/lib/claude/models";
import { guardSql } from "@/lib/admin/sql-guard";

export const dynamic = "force-dynamic";
// Several round trips of SQL plus a written answer. Well inside the platform's
// 300s default, and the model is told to stop long before this matters.
export const maxDuration = 120;

// The Query tab: an admin asks in prose, the model answers by reading the
// database.
//
// It exists because answering "how much has this user spent at the prompts step"
// currently means someone writing a script. Every such question is an aggregate
// or a join over tables the admin dashboard does not chart, and there will always
// be more questions than charts.
//
// Read-only by three independent means, described in
// supabase/migrations/128_admin_query.sql. This route owns the first: nothing
// reaches the database without passing guardSql.
//
// The schema is deliberately NOT described in the prompt. information_schema is
// already in the database, so the model looks the tables up itself: one extra
// round trip in exchange for never drifting out of date, which a hand-written
// schema blurb in a system prompt certainly would.

/** Tool calls per question. Enough for look up the schema, query, refine,
 *  cross-check; low enough that a confused loop costs seconds, not minutes. */
const MAX_STEPS = 10;
/** Rows handed back per query. The database caps at 2000 regardless; this is the
 *  smaller cap that keeps a result set from eating the context window. */
const ROW_CAP = 300;

const SYSTEM = `You are the Heclus admin's data analyst. You answer questions about a production Postgres database by querying it, then reporting what you found.

How to work:
- Look up what you need in information_schema first when you are unsure of a table or column name. Never guess a column.
- One question usually needs several queries: find the ids, then aggregate. Do that rather than asking the admin for clarification you could look up.
- Prefer aggregates over dumping rows. "sum(units) grouped by step" is an answer; 300 raw rows is homework.
- auth.users holds accounts. app_metadata is jsonb: plan, paid, paid_at, plan_expires_at, and a dodo object. Public tables reference users by user_id.

How to answer:
- Lead with the number or the finding, then the shape of it. No preamble.
- When the answer is several rows with several fields, put them in a table: pipe-delimited markdown with a header row, one row per record, only the columns that matter. Keep the headline in prose above it, so the reader gets the answer before the detail. A single number, or a list of one thing, is prose and not a table.
- Plain text otherwise. No markdown emphasis, no headings, no bullet characters: the panel renders tables and paragraphs, and anything else arrives as literal asterisks.
- State the units. Credits are not dollars, tokens are not credits.
- Say what you counted, and what you excluded. If a table only holds rows since a migration, or a value is null for older rows, that changes what the number means and the admin needs to know.
- If the data cannot answer the question, say exactly that and what is missing. Never estimate and present it as measured.
- Numbers you report must come from a query you actually ran in this conversation. Do not carry a figure over from the question or from memory.

You are read-only. Anything other than SELECT is refused, and that is deliberate. Do not suggest workarounds.`;

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

// Our own view of a content block. The SDK's union includes shapes this route
// never asks for, so it is read through unknown rather than widened here.
type LocalBlock = { type: string } & Record<string, unknown>;

export async function POST(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { question } = await req.json().catch(() => ({})) as { question?: string };
  if (!question?.trim()) {
    return NextResponse.json({ error: "Ask a question first." }, { status: 400 });
  }

  const client = await getHeclusDirectClient();
  const modelParams = await resolveDefaultModel();

  // Every query run, returned with the answer. The admin has to be able to see
  // what the number came from: an answer whose working is hidden is a rumour.
  const trail: { sql: string; rows: number; error?: string; ms: number; purpose?: string }[] = [];

  const messages: { role: "user" | "assistant"; content: unknown }[] = [
    { role: "user", content: question.trim() },
  ];

  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const res = await client.messages.create({
        ...modelParams,
        max_tokens: 4096,
        system: SYSTEM,
        tools: [{
          name: "run_sql",
          description:
            "Run one read-only SQL statement against the production database and get the rows back as JSON. " +
            "SELECT or WITH only, one statement, no comments. Rows are capped, so aggregate in SQL rather than " +
            "counting in your head. information_schema is available for looking up tables and columns.",
          input_schema: {
            type: "object",
            properties: {
              sql: { type: "string", description: "The SELECT statement to run." },
              purpose: { type: "string", description: "One short line on what this query is for, shown to the admin." },
            },
            required: ["sql"],
          },
        }],
        messages: messages as never,
      });

      const blocks = (res.content ?? []) as unknown as LocalBlock[];
      messages.push({ role: "assistant", content: blocks });

      const toolUses = blocks.filter((b) => b.type === "tool_use") as unknown as ToolUseBlock[];
      if (toolUses.length === 0) {
        const answer = blocks
          .filter((b) => b.type === "text")
          .map((b) => (b as { text?: string }).text ?? "")
          .join("")
          .trim();
        return NextResponse.json({ answer, trail });
      }

      const results = [];
      for (const call of toolUses) {
        const { sql, purpose } = (call.input ?? {}) as { sql?: unknown; purpose?: unknown };
        const checked = guardSql(sql);
        if (!checked.ok) {
          trail.push({ sql: typeof sql === "string" ? sql : "", rows: 0, error: checked.reason, ms: 0 });
          results.push({
            type: "tool_result" as const,
            tool_use_id: call.id,
            is_error: true,
            content: `Refused: ${checked.reason}`,
          });
          continue;
        }

        const started = Date.now();
        const { data, error } = await supabase.rpc("admin_readonly_query", {
          q: checked.sql,
          row_cap: ROW_CAP,
        });
        const ms = Date.now() - started;

        if (error) {
          // Migrations here are applied by hand, so this route can be live before
          // its function exists. Say so once and stop, rather than letting the
          // model spend all ten steps rediscovering it query by query.
          const missing = /admin_readonly_query/i.test(error.message)
            && /(does not exist|could not find|schema cache)/i.test(error.message);
          if (missing) {
            return NextResponse.json({
              error: "The Query tab needs supabase/migrations/128_admin_query.sql applied to this database. Until then there is nothing for it to read through.",
              trail,
            }, { status: 503 });
          }
          trail.push({ sql: checked.sql, rows: 0, error: error.message, ms });
          results.push({
            type: "tool_result" as const,
            tool_use_id: call.id,
            is_error: true,
            // The database's own message is the most useful thing the model can
            // get: it names the missing column or the syntax error.
            content: `Query failed: ${error.message}`,
          });
          continue;
        }

        const rows = Array.isArray(data) ? data : [];
        trail.push({
          sql: checked.sql,
          rows: rows.length,
          ms,
          ...(typeof purpose === "string" && purpose.trim() ? { purpose: purpose.trim() } : {}),
        });
        results.push({
          type: "tool_result" as const,
          tool_use_id: call.id,
          content: rows.length === 0
            ? "0 rows."
            : `${rows.length} row${rows.length === 1 ? "" : "s"}${rows.length === ROW_CAP ? " (capped, so this may be partial — aggregate in SQL instead)" : ""}:\n${JSON.stringify(rows)}`,
        });
      }

      messages.push({ role: "user", content: results });
    }

    // Out of steps. Say so rather than inventing a conclusion from a half-done
    // investigation.
    return NextResponse.json({
      answer: `I ran ${trail.length} queries without reaching an answer, so I stopped rather than guess. The queries are below if one of them is close.`,
      trail,
      exhausted: true,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "The query agent failed";
    return NextResponse.json({ error: message, trail }, { status: 500 });
  }
}
