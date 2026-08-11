import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";
import { invalidateKnowledgeCache, type KnowledgeEntry } from "@/lib/support-agent/knowledge";

export const dynamic = "force-dynamic";

// What the Heclus agent has been told, editable from the dashboard. Every write
// drops the read cache so a correction takes effect on the next question rather
// than up to a minute later — the whole reason these notes live in the database
// is that a wrong answer needs to stop quickly.

const MAX_TITLE = 120;
const MAX_CONTENT = 4000;

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { data, error } = await supabase
    .from("support_knowledge")
    .select("id, title, content, enabled, sort_order, updated_by, updated_at")
    .order("sort_order", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ entries: (data ?? []) as KnowledgeEntry[] });
}

export async function POST(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const body = await req.json().catch(() => ({})) as { title?: unknown; content?: unknown };
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const content = typeof body.content === "string" ? body.content.trim() : "";
  if (!title || !content) {
    return NextResponse.json({ error: "A title and the note itself are both required." }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("support_knowledge")
    .insert({
      title: title.slice(0, MAX_TITLE),
      content: content.slice(0, MAX_CONTENT),
      updated_by: guard.user.email ?? null,
    })
    .select("id, title, content, enabled, sort_order, updated_by, updated_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  invalidateKnowledgeCache();
  return NextResponse.json({ entry: data as KnowledgeEntry });
}

export async function PUT(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const body = await req.json().catch(() => ({})) as {
    id?: unknown; title?: unknown; content?: unknown; enabled?: unknown; sort_order?: unknown;
  };
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  // Only the fields actually sent are written, so toggling enabled cannot blank
  // a note by omitting its text.
  const update: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: guard.user.email ?? null };
  if (typeof body.title === "string" && body.title.trim()) update.title = body.title.trim().slice(0, MAX_TITLE);
  if (typeof body.content === "string" && body.content.trim()) update.content = body.content.trim().slice(0, MAX_CONTENT);
  if (typeof body.enabled === "boolean") update.enabled = body.enabled;
  if (typeof body.sort_order === "number" && Number.isFinite(body.sort_order)) {
    update.sort_order = Math.round(body.sort_order);
  }

  const { data, error } = await supabase
    .from("support_knowledge")
    .update(update)
    .eq("id", id)
    .select("id, title, content, enabled, sort_order, updated_by, updated_at")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  invalidateKnowledgeCache();
  return NextResponse.json({ entry: data as KnowledgeEntry });
}

export async function DELETE(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { searchParams } = new URL(req.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const { error } = await supabase.from("support_knowledge").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  invalidateKnowledgeCache();
  return NextResponse.json({ ok: true });
}
