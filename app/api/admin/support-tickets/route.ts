import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";

export const dynamic = "force-dynamic";

// Admin triage queue for tickets filed via the in-app HelpButton.
// One endpoint, status filter via ?status= query. Order is created_at
// DESC so the newest unread tickets land at the top. user_id is
// returned but not joined to auth here — the admin panel resolves
// it to an email separately if/when it renders user context.

const VALID_STATUSES = new Set(["open", "in_progress", "resolved", "closed"]);

export async function GET(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const status = url.searchParams.get("status");
  const onlyOpen = url.searchParams.get("onlyOpen");

  let query = supabase
    .from("support_tickets")
    .select("id, ticket_number, user_id, email, subject, message, status, is_open, admin_notes, responded_at, auto_replied_at, auto_reply_draft, created_at, updated_at, plan")
    .order("created_at", { ascending: false })
    .limit(500);

  if (status && VALID_STATUSES.has(status)) {
    query = query.eq("status", status);
  }
  if (onlyOpen === "true") {
    query = query.eq("is_open", true);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ tickets: data ?? [] });
}
