import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";

export const dynamic = "force-dynamic";

// Bulk-mail send history (bulk_mail_sends, migration 095). Feeds the
// admin panel's history section and the per-recipient "emailed Xd ago"
// anti-spam badges. Fail-soft: an empty list (with a note) when the
// table is missing so the panel renders regardless.

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { data, error } = await supabase
    .from("bulk_mail_sends")
    .select("id, phase, template_id, subject, include_video_table, recipient_emails, sent_count, failed_count, created_at")
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) {
    console.warn("[bulk-mail/sends] history unavailable:", error.message);
    return NextResponse.json({ sends: [], note: "History table missing — run supabase/migrations/095_bulk_mail_sends.sql." });
  }

  return NextResponse.json({
    sends: (data ?? []).map((r) => ({
      id: r.id,
      phase: r.phase,
      templateId: r.template_id,
      subject: r.subject,
      includeVideoTable: r.include_video_table,
      recipientEmails: r.recipient_emails ?? [],
      sentCount: r.sent_count,
      failedCount: r.failed_count,
      createdAt: r.created_at,
    })),
  });
}
