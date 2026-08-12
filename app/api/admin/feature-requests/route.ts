import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";
import { isFeatureRequestStatus, type FeatureRequest } from "@/lib/feature-requests";

export const dynamic = "force-dynamic";

// The feature-request board. Admin-only on every verb: the table has RLS on
// with no policy, so this route and its service-role client are the only way
// in or out.

const SELECT = "id, title, notes, status, requester, asked_count, source, created_at, updated_at";

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  // Most-asked first, since that is the whole reason for keeping the count.
  // Newest breaks the tie so a fresh request is not buried under old ones that
  // happen to share its count.
  const { data, error } = await supabase
    .from("feature_requests")
    .select(SELECT)
    .order("asked_count", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ requests: (data ?? []) as FeatureRequest[] });
}

export async function POST(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const body = await req.json().catch(() => ({}));
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) return NextResponse.json({ error: "A title is required." }, { status: 400 });

  const asked = Number(body.asked_count);
  const { data, error } = await supabase
    .from("feature_requests")
    .insert({
      title,
      notes: typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null,
      requester: typeof body.requester === "string" && body.requester.trim() ? body.requester.trim() : null,
      status: isFeatureRequestStatus(body.status) ? body.status : "new",
      source: typeof body.source === "string" && body.source.trim() ? body.source.trim() : null,
      asked_count: Number.isFinite(asked) && asked >= 1 ? Math.floor(asked) : 1,
    })
    .select(SELECT)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ request: data as FeatureRequest });
}

export async function PATCH(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  // Only the named fields, so a stray key in the body can never reach the row.
  const update: Record<string, string | number | null> = { updated_at: new Date().toISOString() };

  if (body.title !== undefined) {
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!title) return NextResponse.json({ error: "A title is required." }, { status: 400 });
    update.title = title;
  }
  if (body.notes !== undefined) {
    update.notes = typeof body.notes === "string" && body.notes.trim() ? body.notes.trim() : null;
  }
  if (body.requester !== undefined) {
    update.requester = typeof body.requester === "string" && body.requester.trim() ? body.requester.trim() : null;
  }
  if (body.source !== undefined) {
    update.source = typeof body.source === "string" && body.source.trim() ? body.source.trim() : null;
  }
  if (body.status !== undefined) {
    if (!isFeatureRequestStatus(body.status)) return NextResponse.json({ error: "Unknown status." }, { status: 400 });
    update.status = body.status;
  }
  if (body.asked_count !== undefined) {
    const n = Number(body.asked_count);
    if (!Number.isFinite(n) || n < 1) {
      return NextResponse.json({ error: "A request has been asked for at least once." }, { status: 400 });
    }
    update.asked_count = Math.floor(n);
  }

  const { data, error } = await supabase
    .from("feature_requests")
    .update(update)
    .eq("id", id)
    .select(SELECT)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ request: data as FeatureRequest });
}

export async function DELETE(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });

  const { error } = await supabase.from("feature_requests").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
