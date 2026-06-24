import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";

export const dynamic = "force-dynamic";

// Update a single support ticket. Supports partial PATCH so the
// admin UI can flip just status, just is_open, or just notes without
// having to round-trip the whole row. Stamps responded_at the first
// time status moves away from 'open' so the dashboard can show
// "response time" without a separate column for the admin-side
// state machine.

const VALID_STATUSES = new Set(["open", "in_progress", "resolved", "closed"]);

interface TicketPatch {
  status?: unknown;
  is_open?: unknown;
  admin_notes?: unknown;
}

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const ticketId = params.id;
  if (!ticketId) return NextResponse.json({ error: "Missing ticket id" }, { status: 400 });

  let body: TicketPatch;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const update: Record<string, unknown> = {};

  if (body.status !== undefined) {
    if (typeof body.status !== "string" || !VALID_STATUSES.has(body.status)) {
      return NextResponse.json({ error: "status must be one of open/in_progress/resolved/closed" }, { status: 400 });
    }
    update.status = body.status;
    // Keep is_open in sync with status unless the caller is
    // overriding it explicitly in the same PATCH. Resolved and
    // closed tickets close the queue entry; open and in_progress
    // keep it visible.
    if (body.is_open === undefined) {
      update.is_open = body.status === "open" || body.status === "in_progress";
    }
  }

  if (body.is_open !== undefined) {
    if (typeof body.is_open !== "boolean") {
      return NextResponse.json({ error: "is_open must be a boolean" }, { status: 400 });
    }
    update.is_open = body.is_open;
  }

  if (body.admin_notes !== undefined) {
    if (body.admin_notes === null || body.admin_notes === "") {
      update.admin_notes = null;
    } else if (typeof body.admin_notes === "string") {
      update.admin_notes = body.admin_notes;
    } else {
      return NextResponse.json({ error: "admin_notes must be string, null, or ''" }, { status: 400 });
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  // First time the ticket moves off "open" we stamp responded_at so
  // the dashboard can show first-response latency. Subsequent status
  // changes don't re-stamp — the field captures first touch only.
  if (update.status && update.status !== "open") {
    const { data: existing } = await supabase
      .from("support_tickets")
      .select("responded_at")
      .eq("id", ticketId)
      .maybeSingle();
    if (existing && !(existing as { responded_at: string | null }).responded_at) {
      update.responded_at = new Date().toISOString();
    }
  }

  const { data, error } = await supabase
    .from("support_tickets")
    .update(update)
    .eq("id", ticketId)
    .select()
    .maybeSingle();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Ticket not found" }, { status: 404 });

  return NextResponse.json({ ok: true, ticket: data });
}
