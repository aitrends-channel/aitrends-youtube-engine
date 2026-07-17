import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-server";
import { getBulkMailAudience, isBulkMailPhase, clampIdleHours, STUCK_PHASES } from "@/lib/admin/bulk-mail-audience";
import { sendEmail } from "@/lib/email/smtp";
import { renderBulkMailHtml, personalizeBulkMail } from "@/lib/email/bulk-mail-template";
import { stuckLineFor } from "@/lib/admin/bulk-mail-template-defaults";
import { supabase } from "@/lib/supabase/client";

export const dynamic = "force-dynamic";
// SMTP sends run serially to respect provider rate limits, so give the
// route headroom for a large audience. Each send is committed the
// moment it goes out, so a timeout still leaves prior sends delivered.
export const maxDuration = 300;

// Reuse the known-good configured support mailbox as the sender — the
// same one support replies go out from.
const FROM = "support@heclus.com";

export async function POST(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: { subject?: unknown; bodyText?: unknown; phase?: unknown; idleHours?: unknown; includeVideoTable?: unknown; templateId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  // The composer decides per template whether the email appends the
  // recipient's stuck-videos table. Defaults on (pre-flag behavior).
  const includeVideoTable = body.includeVideoTable !== false;
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const bodyText = typeof body.bodyText === "string" ? body.bodyText.trim() : "";
  if (!subject) return NextResponse.json({ error: "Subject is required" }, { status: 400 });
  if (!bodyText) return NextResponse.json({ error: "Message body is required" }, { status: 400 });
  if (!isBulkMailPhase(body.phase)) return NextResponse.json({ error: "Unknown or missing phase" }, { status: 400 });
  const idleHours = clampIdleHours(body.idleHours);

  // Recompute the audience server-side at send time from the (validated)
  // phase — never trust a client-supplied recipient list for a bulk email.
  let recipients;
  let videos;
  try {
    ({ recipients, videos } = await getBulkMailAudience(body.phase, idleHours));
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to resolve recipients" },
      { status: 500 },
    );
  }
  if (recipients.length === 0) {
    return NextResponse.json({ error: "No recipients match the audience right now" }, { status: 400 });
  }

  // Fallback step label for the table's Step column (each video row also
  // carries its own resolved step — the "any" audience spans steps).
  const stepLabel = STUCK_PHASES.find((p) => p.id === body.phase)?.label ?? "";
  // {{stuck}} token resolution — audience-aware sentence.
  const stuckLine = stuckLineFor(body.phase);

  // Group each recipient's own matching videos so the email table is
  // specific to them.
  const videosByUser = new Map<string, { title: string; currentState: number; step: string }[]>();
  for (const v of videos) {
    const list = videosByUser.get(v.userId) ?? [];
    list.push({ title: v.title, currentState: v.currentState, step: v.step });
    videosByUser.set(v.userId, list);
  }

  // One message per recipient (individual `to:` — no shared BCC that
  // leaks addresses). Subject/body are personalized ({{name}} → the
  // recipient's first name) and wrapped in the branded Heclus shell with
  // a table of *their* stuck videos; the raw text is sent as the fallback
  // part. Per-recipient failures are collected, never abort the whole run.
  let sent = 0;
  const sentEmails: string[] = [];
  const failed: { email: string; error: string }[] = [];
  for (const r of recipients) {
    try {
      const userVideos = videosByUser.get(r.userId) ?? [];
      // {{video}} pluralization uses the real count even when the table
      // itself is switched off.
      const count = userVideos.length || 1;
      const persSubject = personalizeBulkMail(subject, r.name, count, stuckLine);
      const persBody = personalizeBulkMail(bodyText, r.name, count, stuckLine);
      await sendEmail({
        from: FROM,
        to: r.email,
        subject: persSubject,
        text: persBody,
        html: renderBulkMailHtml(persSubject, persBody, includeVideoTable ? userVideos : [], stepLabel),
      });
      sent += 1;
      sentEmails.push(r.email.toLowerCase());
    } catch (e) {
      failed.push({ email: r.email, error: e instanceof Error ? e.message : "send failed" });
    }
  }

  // Campaign-level history row (bulk_mail_sends, migration 095) — feeds
  // the panel's send history and its "emailed Xd ago" anti-spam badges.
  // Fail-soft: the emails went out; the ledger write is best-effort.
  const templateId = typeof body.templateId === "string" && /^[a-z0-9-]{1,60}$/.test(body.templateId)
    ? body.templateId
    : null;
  const { error: histErr } = await supabase.from("bulk_mail_sends").insert({
    phase: body.phase,
    template_id: templateId,
    subject,
    body_text: bodyText,
    include_video_table: includeVideoTable,
    recipient_emails: sentEmails,
    sent_count: sent,
    failed_count: failed.length,
  });
  if (histErr) console.warn("[bulk-mail/send] history insert failed:", histErr.message);

  return NextResponse.json({
    sent,
    failedCount: failed.length,
    failed: failed.slice(0, 50),
    total: recipients.length,
  });
}
