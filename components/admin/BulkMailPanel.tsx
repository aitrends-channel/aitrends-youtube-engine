"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Mail, Users, AlertTriangle, RefreshCw } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { renderBulkMailHtml, personalizeBulkMail } from "@/lib/email/bulk-mail-template";

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

// Wizard phases (must match STUCK_PHASES ids in lib/admin/bulk-mail-
// audience). Kept as a plain list here so this client component doesn't
// import the server-only audience module. Topic/Script (state 6) and
// Voiceover/Generate (state 14) are split server-side by a column signal.
const PHASES: { id: string; label: string }[] = [
  { id: "channel",    label: "Channel setup" },
  { id: "topic",      label: "Topic" },
  { id: "script",     label: "Script" },
  { id: "visuals",    label: "Visuals" },
  { id: "prompts",    label: "Prompts" },
  { id: "voiceover",  label: "Voiceover" },
  { id: "generate",   label: "Generate" },
  { id: "assemble",   label: "Assemble" },
  { id: "thumbnails", label: "Thumbnails" },
];

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

// Default support check-in template. Phase-aware: the step name is woven
// in so the copy matches the selected audience ("any" gets step-agnostic
// copy). The tone is a genuine support outreach — asking whether they hit
// any issues and what stopped them from finishing. Fully editable;
// "Reset to template" restores it.
function templateFor(phaseId: string): { subject: string; body: string } {
  const stuckLine =
    phaseId === "any"
      ? "I noticed you started a video that hasn't been finished yet."
      : `I noticed your video has been stuck at the ${(PHASES.find((p) => p.id === phaseId)?.label ?? "current").toLowerCase()} step for a while.`;
  return {
    subject: "Checking in on your Heclus {{video}}",
    body: `Hi {{name}},

I'm Alex from the Heclus support team. ${stuckLine}

Did you run into any issues there? Just reply and let me know what got in the way. Happy to help you finish it.

Thanks,
Alex
Heclus Support`,
  };
}

// Selectable starting points for the composer. Only the support check-in
// weaves the selected step into its copy; the others are step-agnostic.
// Picking one replaces the current draft (same semantics as "Reset to
// template") and resumes auto-syncing with the selected condition.
const TEMPLATES: { id: string; label: string; build: (phaseId: string) => { subject: string; body: string } }[] = [
  { id: "checkin", label: "Support check-in", build: templateFor },
  {
    id: "nudge",
    label: "Re-engagement nudge",
    build: () => ({
      subject: "Your Heclus {{video}} is almost there",
      body: `Hi {{name}},

Your {{video}} is saved exactly where you left off - nothing is lost.

Most videos take just a few more minutes to finish once the pipeline is running again. Jump back in and Heclus picks up from the step you stopped at.

If anything got in the way, just reply and I'll help you through it.

Thanks,
Alex
Heclus Support`,
    }),
  },
  {
    id: "founder",
    label: "Founder offer",
    build: () => ({
      subject: "A full year of Heclus for $40",
      body: `Hi {{name}},

Since you have a {{video}} in progress, I wanted to make sure you saw this before it's gone: the Founder offer - a full year of Heclus for a one-time $40. Everything in Starter, 20 niches for the year, no monthly renewal.

It's limited to the first 100 creators and spots are running low.

You can claim it at https://heclus.com/pricing.

Thanks,
Alex
Heclus Support`,
    }),
  },
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
  // users stuck at that step. Both share one grouped filter row.
  const [phase, setPhase] = useState<string>("any");
  const anyMode = phase === "any";
  const audiencePhase = phase;
  const [idleHours, setIdleHours] = useState<number>(24);

  // The duration option lists differ per mode; when a switch strands the
  // current value on an option that no longer exists, fall back to 24h.
  function switchPhase(next: string) {
    const durations = next === "any" ? ANY_DURATIONS : PHASE_DURATIONS;
    if (!durations.some((d) => d.hours === idleHours)) setIdleHours(24);
    setPhase(next);
  }

  const swrKey = `/api/admin/bulk-mail/recipients?phase=${audiencePhase}&idleHours=${idleHours}`;
  const { data, isLoading, mutate, isValidating } = useSWR<RecipientsResponse>(swrKey, fetcher);
  const recipients = data?.recipients ?? [];
  const videos = data?.videos ?? [];
  const activePhaseLabel = anyMode ? "" : PHASES.find((p) => p.id === phase)?.label ?? phase;

  const [templateId, setTemplateId] = useState<string>(TEMPLATES[0].id);
  const activeTemplate = TEMPLATES.find((t) => t.id === templateId) ?? TEMPLATES[0];
  const [subject, setSubject] = useState<string>(() => templateFor("any").subject);
  const [bodyText, setBodyText] = useState<string>(() => templateFor("any").body);
  // Auto-sync the template to the selected step until the admin edits the
  // copy, so the "stuck at the <step> step" line always matches the
  // chosen audience. Once they type, we stop clobbering their message.
  const [edited, setEdited] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (edited) return;
    const t = activeTemplate.build(audiencePhase);
    setSubject(t.subject);
    setBodyText(t.body);
  }, [audiencePhase, edited, activeTemplate]);

  const composed = subject.trim().length > 0 && bodyText.trim().length > 0;
  const canArm = composed && recipients.length > 0 && !sending;

  // Live branded preview — same renderer the send route uses, so what the
  // admin sees is exactly what recipients get. Personalized for a sample
  // recipient (the first match): their name fills {{name}}, and their own
  // stuck videos populate the table, since both are per-recipient at send.
  const sampleName = recipients[0]?.name || "there";
  const sampleUserId = recipients[0]?.userId;
  const previewHtml = useMemo(() => {
    const vids = videos
      .filter((v) => v.userId === sampleUserId)
      .map((v) => ({ title: v.title, currentState: v.currentState, step: v.step }));
    const count = vids.length || 1;
    return renderBulkMailHtml(
      personalizeBulkMail(subject, sampleName, count),
      personalizeBulkMail(bodyText, sampleName, count),
      vids,
      activePhaseLabel,
    );
  }, [subject, bodyText, sampleName, sampleUserId, videos, activePhaseLabel]);

  function resetTemplate() {
    const t = activeTemplate.build(audiencePhase);
    setSubject(t.subject);
    setBodyText(t.body);
    setEdited(false); // resume auto-syncing with the selected step
    setConfirming(false);
  }

  async function send() {
    setSending(true);
    try {
      const res = await fetch("/api/admin/bulk-mail/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: subject.trim(), bodyText: bodyText.trim(), phase: audiencePhase, idleHours }),
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
          </select>

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
        </div>
        <p className="text-[11px] mt-2" style={{ color: "var(--c-45)" }}>
          {anyMode
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
          <div className="flex items-center gap-2">
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
              {TEMPLATES.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
            <button
              onClick={resetTemplate}
              disabled={sending}
              title="Restore the selected template for the selected condition"
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
            <code>{"{{name}}"}</code> → recipient&apos;s first name (falls back to “there”); <code>{"{{video}}"}</code> → “video” / “videos” by count.
          </p>
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
              const label = anyMode ? stepsFor(videos, r.userId) : activePhaseLabel;
              return (
                <li key={r.userId} className="px-3 py-2 flex items-center gap-3 flex-wrap" style={{ borderColor: "var(--bd-7)" }}>
                  <span className="text-sm font-medium min-w-0 truncate" style={{ color: "var(--c-90)" }}>{r.email}</span>
                  {label && (
                    <span className="text-[11px] px-1.5 py-0.5 rounded font-semibold" style={{ background: "oklch(0 0 0 / 0.05)", color: "var(--c-55)" }}>
                      {label}
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
