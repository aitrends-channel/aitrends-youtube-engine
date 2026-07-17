import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";
import {
  DEFAULT_BULK_MAIL_TEMPLATES,
  type BulkMailTemplate,
} from "@/lib/admin/bulk-mail-template-defaults";

export const dynamic = "force-dynamic";

// Editable bulk-mail templates, stored in bulk_mail_templates
// (migration 094). Fail-soft by design: if the table is missing or
// empty, GET serves the code defaults so the composer keeps working —
// only saving edits requires the migration.

interface TemplateRow {
  id: string;
  label: string;
  subject: string;
  body: string;
  video_table: boolean;
  sort_order: number;
}

function toTemplate(r: TemplateRow): BulkMailTemplate {
  return { id: r.id, label: r.label, subject: r.subject, body: r.body, videoTable: r.video_table, sortOrder: r.sort_order };
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { data, error } = await supabase
    .from("bulk_mail_templates")
    .select("id, label, subject, body, video_table, sort_order")
    .order("sort_order", { ascending: true });

  if (error || !data || data.length === 0) {
    if (error) console.warn("[bulk-mail/templates] falling back to defaults:", error.message);
    return NextResponse.json({ templates: DEFAULT_BULK_MAIL_TEMPLATES, source: "defaults" });
  }

  // DB rows win; any default the DB doesn't know yet (e.g. a template
  // added in code after the migration was seeded) is appended so it
  // never disappears from the picker.
  const dbIds = new Set(data.map((r) => r.id));
  const merged = [
    ...(data as TemplateRow[]).map(toTemplate),
    ...DEFAULT_BULK_MAIL_TEMPLATES.filter((t) => !dbIds.has(t.id)),
  ].sort((a, b) => a.sortOrder - b.sortOrder);
  return NextResponse.json({ templates: merged, source: "db" });
}

export async function PUT(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: { id?: unknown; subject?: unknown; body?: unknown; videoTable?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id.trim() : "";
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const text = typeof body.body === "string" ? body.body.trim() : "";
  const videoTable = body.videoTable !== false;
  if (!/^[a-z0-9-]{1,60}$/.test(id)) return NextResponse.json({ error: "Invalid template id" }, { status: 400 });
  if (!subject) return NextResponse.json({ error: "Subject is required" }, { status: 400 });
  if (!text) return NextResponse.json({ error: "Body is required" }, { status: 400 });

  // Label + sort order come from the existing row or the code default —
  // the composer edits content, not identity.
  const fallback = DEFAULT_BULK_MAIL_TEMPLATES.find((t) => t.id === id);
  const { error } = await supabase.from("bulk_mail_templates").upsert(
    {
      id,
      label: fallback?.label ?? id,
      subject,
      body: text,
      video_table: videoTable,
      sort_order: fallback?.sortOrder ?? 99,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "id", ignoreDuplicates: false },
  );
  if (error) {
    // 42P01 = table missing: migration 094 hasn't been applied yet.
    const hint = error.code === "42P01"
      ? "Template table missing — run supabase/migrations/094_bulk_mail_templates.sql first."
      : error.message;
    return NextResponse.json({ error: hint }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
