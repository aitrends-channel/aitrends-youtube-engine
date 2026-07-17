"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Mail, Users, AlertTriangle, RefreshCw } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { renderBulkMailHtml, personalizeBulkMail } from "@/lib/email/bulk-mail-template";
import {
  DEFAULT_BULK_MAIL_TEMPLATES,
  BULK_MAIL_STEP_OPTIONS,
  stuckLineFor,
  type BulkMailTemplate,
} from "@/lib/admin/bulk-mail-template-defaults";

interface Recipient {
  userId: string;
  email: string;
  name: string;
  projectCount: number;
  furthestState: number;
  lastActivity: string;
}

interface Video {
  projectId: string;
  userId: string;
  ownerEmail: string;
  title: string;
  currentState: number;
  step: string;
  lastActivity: string;
}

interface RecipientsResponse {
  recipients: Recipient[];
  videos: Video[];
  total: number;
  phase: string;
  idleHours: number;
}

interface SendHistoryRow {
  id: string;
  phase: string;
  templateId: string | null;
  subject: string;
  includeVideoTable: boolean;
  recipientEmails: string[];
  sentCount: number;
  failedCount: number;
  createdAt: string;
}

// Human label for an audience id in the history list.
const CUSTOMER_AUDIENCE_LABELS: Record<string, string> = {
  "paid-no-setup": "Paid, no setup",
  "paid-setup-no-video": "Paid, no niche",
  "free-inactive-3d": "Free/demo inactive 3d+",
};
function audienceLabelFor(phase: string): string {
  if (phase === "any") return "Any unfinished video";
  const step = BULK_MAIL_STEP_OPTIONS.find((p) => p.id === phase);
  if (step) return `Stuck at ${step.label}`;
  return CUSTOMER_AUDIENCE_LABELS[phase] ?? phase;
}

// Wizard phases (ids match STUCK_PHASES in lib/admin/bulk-mail-audience).
// Sourced from the client-safe defaults module so this component never
// imports the server-only audience module.
const PHASES = BULK_MAIL_STEP_OPTIONS;

// Idle-threshold options per audience mode.
const PHASE_DURATIONS: { label: string; hours: number }[] = [
  { label: "12 hours", hours: 12 },
  { label: "24 hours", hours: 24 },
  { label: "over 2 days", hours: 48 },
  { label: "over 7 days", hours: 168 },
];
const ANY_DURATIONS: { label: string; hours: number }[] = [
  { label: "Over 12 hours", hours: 12 },
  { label: "Over 24 hours", hours: 24 },
  { label: "Over 3 days", hours: 72 },
  { label: "Over 7 days", hours: 168 },
  { label: "Over 1 month", hours: 720 },
];


const fetcher = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));

function timeAgo(iso: string): string {
  const min = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return `${Math.floor(day / 30)}mo ago`;
}

// Single composer. The audience filters are grouped into one control
// row — the first select picks the condition ("any unfinished video" or
// a specific stuck-at step, phase "any" vs step ids server-side), the
// second the idle duration — so there's exactly one template/composer
// section instead of the old duplicated two-column layout.
export function BulkMailPanel() {
  return <MailComposer />;
}

const selectStyle = {
  border: "2px solid oklch(0.62 0.15 220 / 0.45)",
  boxShadow: "0 1px 3px oklch(0 0 0 / 0.08)",
} as const;

function MailComposer() {
  // "any" targets owners of any unfinished video; a step id targets
  // users stuck at that step; customer audiences ("paid-*",
  // "free-inactive-3d") target accounts by funnel position or
  // inactivity — those carry their own window, so the idle selector
  // hides for them.
  const [phase, setPhase] = useState<string>("any");
  const anyMode = phase === "any";
  const customerMode = phase.startsWith("paid-") || phase === "free-inactive-3d";
  const audiencePhase = phase;
  const [idleHours, setIdleHours] = useState<number>(24);

  // Templates come from the DB (migration 094) and are editable via
  // "Save to template"; the API serves the code defaults until the
  // table exists, so the composer always has something to offer.
  const { data: tplData, mutate: mutateTemplates } = useSWR<{ templates: BulkMailTemplate[] }>(
    "/api/admin/bulk-mail/templates", fetcher,
  );
  const templates = tplData?.templates ?? DEFAULT_BULK_MAIL_TEMPLATES;

  // Send history (bulk_mail_sends) — the anti-spam backbone: powers the
  // history list below and the "emailed Xd ago" badges on recipients.
  const { data: sendsData, mutate: mutateSends } = useSWR<{ sends: SendHistoryRow[]; note?: string }>(
    "/api/admin/bulk-mail/sends", fetcher,
  );
  const sends = sendsData?.sends ?? [];
  // email (lowercased) → most recent bulk-send timestamp.
  const lastEmailedAt = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sends) {
      const t = new Date(s.createdAt).getTime();
      for (const e of s.recipientEmails) {
        const key = e.toLowerCase();
        const prev = m.get(key);
        if (!prev || t > prev) m.set(key, t);
      }
    }
    return m;
  }, [sends]);
  const RECENTLY_EMAILED_MS = 7 * 24 * 60 * 60 * 1000;

  const [templateId, setTemplateId] = useState<string>(DEFAULT_BULK_MAIL_TEMPLATES[0].id);
  const activeTemplate = templates.find((t) => t.id === templateId) ?? templates[0];
  const [includeVideoTable, setIncludeVideoTable] = useState<boolean>(DEFAULT_BULK_MAIL_TEMPLATES[0].videoTable);
  const [subject, setSubject] = useState<string>(DEFAULT_BULK_MAIL_TEMPLATES[0].subject);
  const [bodyText, setBodyText] = useState<string>(DEFAULT_BULK_MAIL_TEMPLATES[0].body);
  // Until the admin edits the draft, it tracks the selected template
  // (including when the saved copy arrives from the DB). Once they
  // type, we stop clobbering their message.
  const [edited, setEdited] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);

  useEffect(() => {
    if (edited || !activeTemplate) return;
    setSubject(activeTemplate.subject);
    setBodyText(activeTemplate.body);
    setIncludeVideoTable(activeTemplate.videoTable);
  }, [edited, activeTemplate]);

  // The duration option lists differ per mode; when a switch strands the
  // current value on an option that no longer exists, fall back to 24h.
  // Picking a customer audience also auto-selects its paired template
  // (same id) unless the admin has edited the draft.
  function switchPhase(next: string) {
    const durations = next === "any" ? ANY_DURATIONS : PHASE_DURATIONS;
    if (!durations.some((d) => d.hours === idleHours)) setIdleHours(24);
    if (!edited) {
      if (templates.some((t) => t.id === next)) setTemplateId(next);
      else if (templateId.startsWith("paid-")) setTemplateId(templates[0]?.id ?? DEFAULT_BULK_MAIL_TEMPLATES[0].id);
    }
    setPhase(next);
  }

  const swrKey = `/api/admin/bulk-mail/recipients?phase=${audiencePhase}&idleHours=${idleHours}`;
  const { data, isLoading, mutate, isValidating } = useSWR<RecipientsResponse>(swrKey, fetcher);
  const recipients = data?.recipients ?? [];
  const videos = data?.videos ?? [];
  // Empty for "any" and the customer audiences — their video rows carry
  // per-row resolved step labels instead of one shared phase label.
  const activePhaseLabel = anyMode || customerMode ? "" : PHASES.find((p) => p.id === phase)?.label ?? phase;

  const composed = subject.trim().length > 0 && bodyText.trim().length > 0;
  const canArm = composed && recipients.length > 0 && !sending;

  // Live branded preview — same renderer the send route uses, so what the
  // admin sees is exactly what recipients get. Personalized for a sample
  // recipient (the first match): their name fills {{name}}, their own
  // stuck videos populate the table, and {{stuck}} resolves for the
  // selected audience, since all are per-send at delivery time.
  const sampleName = recipients[0]?.name || "there";
  const sampleUserId = recipients[0]?.userId;
  const previewHtml = useMemo(() => {
    const vids = videos
      .filter((v) => v.userId === sampleUserId)
      .map((v) => ({ title: v.title, currentState: v.currentState, step: v.step }));
    // {{video}} pluralization always uses the real count, even when the
    // table itself is switched off.
    const count = vids.length || 1;
    const stuck = stuckLineFor(audiencePhase);
    return renderBulkMailHtml(
      personalizeBulkMail(subject, sampleName, count, stuck),
      personalizeBulkMail(bodyText, sampleName, count, stuck),
      includeVideoTable ? vids : [],
      activePhaseLabel,
    );
  }, [subject, bodyText, sampleName, sampleUserId, videos, activePhaseLabel, includeVideoTable, audiencePhase]);

  function resetTemplate() {
    setSubject(activeTemplate.subject);
    setBodyText(activeTemplate.body);
    setIncludeVideoTable(activeTemplate.videoTable);
    setEdited(false); // resume tracking the selected template
    setConfirming(false);
  }

  // Persist the current draft (subject/body/table flag) to the selected
  // template so it becomes the new saved version for every admin.
  async function saveTemplate() {
    setSavingTemplate(true);
    try {
      const res = await fetch("/api/admin/bulk-mail/templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: templateId, subject: subject.trim(), body: bodyText.trim(), videoTable: includeVideoTable }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? `Save failed (${res.status})`);
      toast.success(`Saved to “${activeTemplate.label}”`);
      setEdited(false); // draft now equals the saved template again
      mutateTemplates();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSavingTemplate(false);
    }
  }

  async function send() {
    setSending(true);
    try {
      const res = await fetch("/api/admin/bulk-mail/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: subject.trim(), bodyText: bodyText.trim(), phase: audiencePhase, idleHours, includeVideoTable, templateId }),
      });
      const d = (await res.json().catch(() => ({}))) as { sent?: number; failedCount?: number; error?: string };
      if (!res.ok) throw new Error(d.error ?? `Send failed (${res.status})`);
      toast.success(
        `Sent to ${d.sent} user${d.sent === 1 ? "" : "s"}` + (d.failedCount ? ` · ${d.failedCount} failed` : ""),
      );
      setSubject("");
      setBodyText("");
      setConfirming(false);
      mutate();
      mutateSends();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Audience — all filters grouped in one row: the condition
          (any unfinished video / stuck at a step) and the idle window. */}
      <div>
        <h3 className="text-base font-semibold mb-2" style={{ color: "var(--c-90)" }}>
          Audience
        </h3>
        <div className="flex items-center gap-2 flex-wrap">
          <select
            value={phase}
            onChange={(e) => { switchPhase(e.target.value); setConfirming(false); }}
            className="px-3 py-2.5 rounded-lg text-base font-semibold outline-none bg-white text-zinc-900 cursor-pointer min-w-[220px]"
            style={selectStyle}
          >
            <option value="any">Any unfinished video</option>
            <optgroup label="Stuck at step">
              {PHASES.map((p) => (
                <option key={p.id} value={p.id}>Stuck at {p.label}</option>
              ))}
            </optgroup>
            <optgroup label="Customers">
              <option value="paid-no-setup">Paid users with no setup</option>
              <option value="paid-setup-no-video">Paid users with setup but zero video</option>
              <option value="free-inactive-3d">Free/demo users with no activity in the past 3 days</option>
            </optgroup>
          </select>

          {!customerMode && (
            <>
              <span className="text-sm" style={{ color: "var(--c-55)" }}>idle for</span>

              <select
                value={idleHours}
                onChange={(e) => { setIdleHours(Number(e.target.value)); setConfirming(false); }}
                className="px-3 py-2.5 rounded-lg text-base font-semibold outline-none bg-white text-zinc-900 cursor-pointer"
                style={selectStyle}
              >
                {(anyMode ? ANY_DURATIONS : PHASE_DURATIONS).map((d) => (
                  <option key={d.hours} value={d.hours}>{d.label}</option>
                ))}
              </select>
            </>
          )}
        </div>
        <p className="text-[11px] mt-2" style={{ color: "var(--c-45)" }}>
          {phase === "paid-no-setup"
            ? "Paying customers who haven't finished account setup (no API key saved) — no idle window, matched regardless of last activity."
            : phase === "paid-setup-no-video"
            ? "Paying customers with account setup done but no niche created yet (no channel analyzed) — no idle window."
            : phase === "free-inactive-3d"
            ? "Free or demo users (never paid) with no sign-in and no project activity in the past 3 days — includes accounts that never did anything."
            : anyMode
            ? "Targets owners of any unfinished video, whatever step it's on, idle for the selected duration."
            : "“Stuck at” = the user is currently at that step and has been idle for the selected duration."}
        </p>
      </div>

      {/* Audience summary */}
      <div
        className="rounded-xl px-4 py-3 flex items-center justify-between gap-3 flex-wrap"
        style={{ background: "oklch(0.62 0.15 220 / 0.06)", border: "1px solid oklch(0.62 0.15 220 / 0.25)" }}
      >
        <div className="flex items-center gap-2.5">
          <Users size={18} style={{ color: "oklch(0.5 0.15 220)" }} />
          <span className="text-sm" style={{ color: "var(--c-70)" }}>
            {isLoading ? (
              <span className="inline-flex items-center gap-2"><Spinner size={12} /> Resolving audience…</span>
            ) : (
              <>
                <span className="font-bold text-base" style={{ color: "var(--c-90)" }}>{recipients.length}</span>{" "}
                user{recipients.length === 1 ? "" : "s"} match this condition
                {anyMode && videos.length > 0 && (
                  <span style={{ color: "var(--c-50)" }}> · {videos.length} video{videos.length === 1 ? "" : "s"}</span>
                )}
              </>
            )}
          </span>
        </div>
        <button
          onClick={() => mutate()}
          disabled={isValidating}
          className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1.5 rounded-lg cursor-pointer disabled:opacity-40"
          style={{ background: "oklch(0 0 0 / 0.04)", color: "var(--c-60)", border: "1px solid var(--bd-7)" }}
        >
          <RefreshCw size={12} className={isValidating ? "animate-spin" : ""} /> Refresh
        </button>
      </div>

      {/* Composer */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <p className="text-xs uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Email content</p>
          <div className="flex items-center gap-2 flex-wrap">
            <label
              className="inline-flex items-center gap-1.5 text-xs font-semibold cursor-pointer select-none"
              style={{ color: "var(--c-60)" }}
              title="Append a table of the recipient's own stuck videos to the email"
            >
              <input
                type="checkbox"
                checked={includeVideoTable}
                onChange={(e) => { setIncludeVideoTable(e.target.checked); setConfirming(false); }}
                disabled={sending}
                className="accent-zinc-700"
              />
              Video table
            </label>
            {/* Picking a template intentionally replaces the draft — same
                semantics as "Reset to template", just a different preset. */}
            <select
              value={templateId}
              onChange={(e) => { setTemplateId(e.target.value); setEdited(false); setConfirming(false); }}
              disabled={sending}
              title="Start from a preset template"
              className="px-2.5 py-1.5 rounded-lg text-xs font-semibold outline-none bg-white text-zinc-900 cursor-pointer disabled:opacity-40"
              style={selectStyle}
            >
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
            <button
              onClick={resetTemplate}
              disabled={sending || savingTemplate}
              title="Restore the saved version of the selected template"
              className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg cursor-pointer disabled:opacity-40"
              style={{ background: "oklch(0 0 0 / 0.04)", color: "var(--c-60)", border: "1px solid var(--bd-7)" }}
            >
              <RefreshCw size={12} /> Reset to template
            </button>
          </div>
        </div>
        <div>
          <label className="text-xs uppercase tracking-wider block mb-1.5" style={{ color: "var(--c-40)" }}>Subject</label>
          <input
            value={subject}
            onChange={(e) => { setSubject(e.target.value); setEdited(true); setConfirming(false); }}
            disabled={sending}
            placeholder="e.g. Your video is still waiting to finish"
            className="w-full px-3 py-2.5 rounded-lg text-base outline-none bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400 placeholder:text-zinc-400"
          />
        </div>
        <div>
          <label className="text-xs uppercase tracking-wider block mb-1.5" style={{ color: "var(--c-40)" }}>Message</label>
          <textarea
            value={bodyText}
            onChange={(e) => { setBodyText(e.target.value); setEdited(true); setConfirming(false); }}
            disabled={sending}
            rows={8}
            placeholder="Write the email body. Line breaks are preserved. This goes to every user matching the condition above."
            className="w-full px-3 py-2 rounded-lg text-base outline-none bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400 resize-y placeholder:text-zinc-400"
          />
          <p className="text-[11px] mt-1" style={{ color: "var(--c-45)" }}>
            <code>{"{{name}}"}</code> → recipient&apos;s first name (falls back to “there”); <code>{"{{video}}"}</code> → “video” / “videos” by count;{" "}
            <code>{"{{stuck}}"}</code> → audience-aware sentence (“…stuck at the topic step for a while.”).
          </p>
          {/* Persist the draft to the DB as the selected template's new
              saved version — sits under the editor so it reads as
              "save what I just wrote". */}
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={saveTemplate}
              disabled={sending || savingTemplate || !composed}
              title="Save the current subject, message, and video-table setting to the database as this template"
              className="inline-flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-lg cursor-pointer disabled:opacity-40 transition-opacity hover:opacity-90"
              style={{ background: "oklch(0.62 0.15 220)", color: "white" }}
            >
              {savingTemplate ? (<><Spinner size={12} className="text-white" /> Saving…</>) : <>Save template</>}
            </button>
            <span className="text-[11px]" style={{ color: "var(--c-45)" }}>
              Saves your edits to “{activeTemplate.label}” for every future send.
            </span>
          </div>
        </div>

        {/* Live branded preview of the exact email recipients receive. */}
        <div>
          <p className="text-xs uppercase tracking-wider mb-1.5" style={{ color: "var(--c-40)" }}>
            Preview — branded email recipients receive
          </p>
          <iframe
            title="Branded email preview"
            srcDoc={previewHtml}
            sandbox=""
            className="w-full rounded-xl block"
            style={{ height: 480, border: "1px solid var(--bd-7)", background: "#080808" }}
          />
        </div>
      </div>

      {/* Send / two-step confirm */}
      <div className="flex items-center gap-3 flex-wrap">
        {!confirming ? (
          <button
            onClick={() => setConfirming(true)}
            disabled={!canArm}
            className="px-4 py-2.5 rounded-xl text-base font-semibold transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-2"
            style={{ background: "oklch(0.62 0.15 220)", color: "white" }}
          >
            <Mail size={16} />
            Send to {recipients.length} user{recipients.length === 1 ? "" : "s"}
          </button>
        ) : (
          <>
            <button
              onClick={send}
              disabled={sending}
              className="px-4 py-2.5 rounded-xl text-base font-semibold transition-all hover:opacity-90 disabled:opacity-60 inline-flex items-center gap-2"
              style={{ background: "oklch(0.6 0.22 25)", color: "white" }}
            >
              {sending ? (
                <><Spinner size={14} className="text-white" /> Sending…</>
              ) : (
                <><AlertTriangle size={16} /> Confirm — email {recipients.length} user{recipients.length === 1 ? "" : "s"}</>
              )}
            </button>
            {!sending && (
              <button
                onClick={() => setConfirming(false)}
                className="px-4 py-2.5 rounded-xl text-base font-semibold cursor-pointer"
                style={{ background: "oklch(0 0 0 / 0.04)", color: "var(--c-60)", border: "1px solid var(--bd-7)" }}
              >
                Cancel
              </button>
            )}
          </>
        )}
        <span className="text-xs" style={{ color: "var(--c-45)" }}>
          {!composed ? "Add a subject and message to enable sending." : "One message per user, sent from support@heclus.com."}
        </span>
        {(() => {
          const recentCount = recipients.filter((r) => {
            const t = lastEmailedAt.get(r.email.toLowerCase());
            return t !== undefined && Date.now() - t <= RECENTLY_EMAILED_MS;
          }).length;
          return recentCount > 0 ? (
            <span className="text-xs font-semibold w-full sm:w-auto" style={{ color: "oklch(0.55 0.15 65)" }}>
              ⚠ {recentCount} of {recipients.length} matched user{recipients.length === 1 ? "" : "s"} already received a bulk email in the last 7 days.
            </span>
          ) : null;
        })()}
      </div>

      {/* Audience detail. The "any" audience has no single step, so each
          row's badge shows the steps of that user's matching videos. */}
      <div>
        <p className="text-xs uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>
          Recipients{recipients.length > 0 ? ` (${recipients.length})` : ""}
        </p>
        {isLoading ? (
          <div className="flex items-center gap-2 py-6 text-sm" style={{ color: "var(--c-50)" }}>
            <Spinner size={14} /> Loading…
          </div>
        ) : recipients.length === 0 ? (
          <div className="py-8 text-center text-sm" style={{ color: "var(--c-45)" }}>
            No users match this condition right now.
          </div>
        ) : (
          <ul
            className="rounded-xl divide-y overflow-hidden"
            style={{ border: "1px solid var(--bd-7)", background: "oklch(0 0 0 / 0.02)" }}
          >
            {recipients.map((r) => {
              const label = anyMode || customerMode ? stepsFor(videos, r.userId) : activePhaseLabel;
              const lastMailed = lastEmailedAt.get(r.email.toLowerCase());
              const mailedRecently = lastMailed !== undefined && Date.now() - lastMailed <= RECENTLY_EMAILED_MS;
              return (
                <li key={r.userId} className="px-3 py-2 flex items-center gap-3 flex-wrap" style={{ borderColor: "var(--bd-7)" }}>
                  <span className="text-sm font-medium min-w-0 truncate" style={{ color: "var(--c-90)" }}>{r.email}</span>
                  {label && (
                    <span className="text-[11px] px-1.5 py-0.5 rounded font-semibold" style={{ background: "oklch(0 0 0 / 0.05)", color: "var(--c-55)" }}>
                      {label}
                    </span>
                  )}
                  {mailedRecently && (
                    <span className="text-[11px] px-1.5 py-0.5 rounded font-semibold"
                      title="This user already received a bulk email recently"
                      style={{ background: "oklch(0.72 0.18 65 / 0.12)", color: "oklch(0.5 0.15 65)", border: "1px solid oklch(0.72 0.18 65 / 0.3)" }}>
                      emailed {timeAgo(new Date(lastMailed).toISOString())}
                    </span>
                  )}
                  {r.projectCount > 1 && (
                    <span className="text-[11px]" style={{ color: "var(--c-45)" }}>{r.projectCount} videos</span>
                  )}
                  <span className="text-xs ml-auto" style={{ color: "var(--c-45)" }}>{timeAgo(r.lastActivity)}</span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Send history — every bulk email category ever sent, newest
          first, so it's obvious who was contacted when. */}
      <div>
        <p className="text-xs uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>
          Send history{sends.length > 0 ? ` (${sends.length})` : ""}
        </p>
        {sendsData?.note ? (
          <p className="text-xs py-2" style={{ color: "var(--c-45)" }}>{sendsData.note}</p>
        ) : sends.length === 0 ? (
          <p className="text-xs py-2 italic" style={{ color: "var(--c-40)" }}>No bulk emails sent yet.</p>
        ) : (
          <ul
            className="rounded-xl divide-y overflow-hidden"
            style={{ border: "1px solid var(--bd-7)", background: "oklch(0 0 0 / 0.02)" }}
          >
            {sends.map((s) => (
              <li key={s.id} className="px-3 py-2 flex items-center gap-2.5 flex-wrap" style={{ borderColor: "var(--bd-7)" }}>
                <span className="text-[11px] px-1.5 py-0.5 rounded font-semibold shrink-0"
                  style={{ background: "oklch(0.62 0.15 220 / 0.1)", color: "oklch(0.45 0.13 220)", border: "1px solid oklch(0.62 0.15 220 / 0.3)" }}>
                  {audienceLabelFor(s.phase)}
                </span>
                {s.templateId && (
                  <span className="text-[11px] px-1.5 py-0.5 rounded font-semibold shrink-0"
                    style={{ background: "oklch(0 0 0 / 0.05)", color: "var(--c-55)" }}>
                    {templates.find((t) => t.id === s.templateId)?.label ?? s.templateId}
                  </span>
                )}
                <span className="text-sm min-w-0 truncate" style={{ color: "var(--c-80)" }} title={s.subject}>
                  {s.subject}
                </span>
                <span className="text-xs ml-auto shrink-0 tabular-nums" style={{ color: "var(--c-50)" }}>
                  {s.sentCount} sent{s.failedCount > 0 ? ` · ${s.failedCount} failed` : ""} · {timeAgo(s.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// Badge text for an "any"-audience recipient: the distinct steps of their
// matching videos, capped so the row stays one line.
function stepsFor(videos: Video[], userId: string): string {
  const steps = [...new Set(videos.filter((v) => v.userId === userId).map((v) => v.step))];
  if (steps.length === 0) return "";
  return steps.length > 2 ? `${steps.slice(0, 2).join(", ")} +${steps.length - 2}` : steps.join(", ");
}
