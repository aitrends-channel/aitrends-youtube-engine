import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";
import { sendEmail } from "@/lib/email/smtp";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/emails?direction=inbound|outbound&q=<text>&limit=N&offset=N
 *
 * List the emails for the admin Emails tab. Filters:
 *   - direction: inbound (default) or outbound. "all" returns both.
 *   - q: case-insensitive substring match across subject + from + to.
 *   - limit / offset: paginate, defaults 50 / 0.
 *
 * Returns rows newest-first by received_at (sent_at coalesces in for
 * outbound). Bodies are NOT included in the list — only headers and
 * a short snippet — to keep payloads small. The detail GET below
 * returns the full body.
 */
export async function GET(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(req.url);
  const direction = searchParams.get("direction") ?? "inbound";
  const q = (searchParams.get("q") ?? "").trim();
  const limit = Math.min(200, Math.max(1, Number(searchParams.get("limit") ?? 50)));
  const offset = Math.max(0, Number(searchParams.get("offset") ?? 0));

  let query = supabase
    .from("emails")
    .select("id, direction, message_id, from_address, to_addresses, subject, body_text, received_at, sent_at, is_read, in_reply_to, thread_root_id, is_replied, replied_at, auto_replied_at, auto_reply_draft");

  if (direction === "inbound" || direction === "outbound") {
    query = query.eq("direction", direction);
  }
  if (q) {
    // Postgres ilike OR across the three searchable text fields.
    // PostgREST `or` syntax: comma-separated conditions, each
    // value-quoted as needed. .ilike treats % as wildcard so we
    // wrap the term in % on both sides.
    const term = q.replace(/[,()]/g, "");
    query = query.or(`subject.ilike.%${term}%,from_address.ilike.%${term}%`);
  }

  // Order by received_at for inbound, sent_at for outbound. Use a
  // single coalesced order so the merged "all" view stays sorted.
  query = query
    .order("received_at", { ascending: false, nullsFirst: false })
    .order("sent_at", { ascending: false, nullsFirst: false })
    .range(offset, offset + limit - 1);

  const { data, error } = await query;
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Trim body_text into a snippet for the list view — keeps the
  // payload small and the UI doesn't need the full body on the row.
  const rows = (data ?? []).map((r) => ({
    ...r,
    snippet: r.body_text ? r.body_text.slice(0, 180) : null,
    body_text: undefined,
  }));

  return NextResponse.json({ emails: rows });
}

/**
 * POST /api/admin/emails
 *
 * Send a new email. Body shape:
 *   {
 *     from: "support@heclus.com" | "info@heclus.com",
 *     to:   "user@example.com" | string[],
 *     cc?:  string | string[],
 *     subject: string,
 *     text?: string,
 *     html?: string,
 *     inReplyTo?: string   // Message-ID of the parent for threaded replies
 *   }
 *
 * Both text and html are accepted; pass at least one. On success we
 * return { messageId } — the same id is also written into the
 * emails table as the outbound row so the dashboard's Sent view
 * shows it immediately.
 */
export async function POST(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const body = await req.json().catch(() => ({})) as {
    from?: string;
    to?: string | string[];
    cc?: string | string[];
    subject?: string;
    text?: string;
    html?: string;
    inReplyTo?: string;
  };

  if (!body.from || !body.to || !body.subject) {
    return NextResponse.json({ error: "from, to, and subject are required" }, { status: 400 });
  }
  if (!body.text && !body.html) {
    return NextResponse.json({ error: "Provide at least one of text or html" }, { status: 400 });
  }

  try {
    const { messageId } = await sendEmail({
      from: body.from,
      to: body.to,
      cc: body.cc,
      subject: body.subject,
      text: body.text,
      html: body.html,
      inReplyTo: body.inReplyTo,
    });
    return NextResponse.json({ ok: true, messageId });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Send failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
