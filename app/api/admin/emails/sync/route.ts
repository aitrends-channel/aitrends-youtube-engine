import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-server";
import { syncInbox } from "@/lib/email/imap";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * POST /api/admin/emails/sync
 *
 * Pull new mail from Hostinger IMAP and write rows into the emails
 * table. Triggered manually by the dashboard's Sync button and
 * automatically by the UI when the Emails tab is opened.
 *
 * Returns the sync stats so the UI can show "N new messages" or
 * a no-op confirmation. Not idempotent in the sense of "no DB
 * writes" — UIDVALIDITY resets will re-insert dupes, which the
 * unique(message_id) constraint blocks (counted as skipped).
 */
export async function POST() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  try {
    const stats = await syncInbox();
    return NextResponse.json({ ok: true, ...stats });
  } catch (err) {
    const message = err instanceof Error ? err.message : "IMAP sync failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
