"use client";

import { useState, useEffect, useRef, useCallback, use, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { WizardNav } from "@/components/wizard/WizardNav";
import { StepCostCard } from "@/components/StepCostCard";
import { CostTipsModal } from "@/components/CostTipsModal";
import { StepBalanceCard } from "@/components/StepBalanceCard";
import { useProject } from "@/hooks/useProject";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { ChevronUp, ChevronDown, Download, Check } from "lucide-react";
import { joinSegments } from "@/lib/text/joinSegments";
import { dedupeOverlap } from "@/lib/text/dedupeOverlap";
import { planBulkMerge, findStubs } from "@/lib/text/mergePlan";
import { MERGE_BEATS_HIDDEN, PROMPTS_THREE_STEP } from "@/lib/feature-flags";
import { friendlyError } from "@/lib/errors/friendly";
import { PREFIX_MAX_CHARS } from "@/lib/prefix-limit";
import type { Beat } from "@/lib/types";

// ── Sub-components ─────────────────────────────────────────────────────────

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <button
      onClick={handleCopy}
      title="Copy to clipboard"
      className="shrink-0 w-5 h-5 flex items-center justify-center rounded transition-colors"
      style={{ color: copied ? "oklch(0.7 0.15 145)" : "var(--c-35)" }}
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <rect x="4" y="1" width="7" height="8" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
          <path d="M1 4.5h0a1.5 1.5 0 0 1 1.5-1.5H4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <rect x="1" y="4" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
        </svg>
      )}
    </button>
  );
}

// Inline prompt editor used on the prompts step. Renders the prompt as
// read-only text with an "Edit" affordance; toggling shows a textarea +
// Save/Cancel. Save PATCHes the single beat's prompt text (no media
// regeneration) then refreshes the project cache. Mirrors the app's
// dark token palette and the primary-purple action button used
// elsewhere on this page.
function EditablePrompt({
  value,
  field,
  beatNumber,
  projectId,
  onSaved,
  accent,
  textColor,
}: {
  value: string | null | undefined;
  field: "image" | "video" | "segment";
  beatNumber: number;
  projectId: string;
  onSaved: () => Promise<unknown> | void;
  accent: string;
  textColor: string;
}) {
  const noun = field === "segment" ? "segment" : `${field} prompt`;
  // Coerce to a string up front — a beat may not have this prompt yet
  // (null/undefined), and draft.trim() would throw during render.
  const safeValue = value ?? "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(safeValue);
  const [saving, setSaving] = useState(false);

  // Keep the draft in step with the underlying prompt if it changes
  // upstream (e.g. a regenerate on another step) while we're not
  // actively editing this field.
  useEffect(() => {
    if (!editing) setDraft(safeValue);
  }, [safeValue, editing]);

  const trimmed = draft.trim();
  const canSave = !saving && trimmed.length > 0 && trimmed !== safeValue.trim();

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/beats/prompt`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ beatNumber, field, value: trimmed }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? `Request failed (HTTP ${res.status})`);
      await onSaved();
      setEditing(false);
      toast.success(`Beat ${beatNumber} ${noun} saved`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `Failed to save ${noun}`);
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div>
        {safeValue
          ? <p className="text-sm leading-relaxed" style={{ color: textColor }}>{safeValue}</p>
          : <p className="text-xs italic" style={{ color: "var(--c-35)" }}>No {noun} yet.</p>}
        <button
          onClick={(e) => { e.stopPropagation(); setDraft(safeValue); setEditing(true); }}
          className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium transition-opacity hover:opacity-80"
          style={{ color: accent }}
        >
          <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
            <path d="M8.5 1.5l2 2L4 10l-2.5.5L2 8l6.5-6.5z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
          </svg>
          Edit
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={5}
        autoFocus
        disabled={saving}
        className="w-full rounded-lg text-sm leading-relaxed p-3 outline-none resize-y disabled:opacity-60"
        style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-card)", color: "var(--c-80)" }}
      />
      <div className="flex items-center gap-2">
        <button
          onClick={save}
          disabled={!canSave}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 transition-opacity disabled:opacity-40"
          style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
        >
          {saving && (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="animate-spin">
              <circle cx="6" cy="6" r="4.5" stroke="currentColor" strokeWidth="1.5" strokeOpacity="0.25" />
              <path d="M6 1.5a4.5 4.5 0 0 1 4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          )}
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          onClick={() => { setEditing(false); setDraft(safeValue); }}
          disabled={saving}
          className="px-3 py-1.5 rounded-lg text-xs font-medium transition-colors disabled:opacity-40"
          style={{ border: "1px solid var(--bd-card)", color: "var(--c-55)" }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// A beat this short can't carry an image and a clip of its own — the
// splitter occasionally emits one. Flagged so the user can spot it in a
// long list and merge it away.
const SHORT_BEAT_WORDS = 3;
function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function BeatCard({ beat, projectId, onSaved, consistencyPreview, mode, isFirst, isLast, canMerge, mergeHint, onMerge }: {
  beat: Beat;
  projectId: string;
  onSaved: () => Promise<unknown> | void;
  consistencyPreview?: string | null;
  /** Which tab this card is rendered in. "beats" shows the narration and the
   *  merge controls; "image" shows only the prompt written for it. Keeping them
   *  apart is the point of the split — a prompt tab that also showed segments
   *  made the two impossible to scan separately. */
  mode: "beats" | "image";
  isFirst: boolean;
  isLast: boolean;
  /** False outside the merge window. The controls stay visible and disabled
   *  rather than vanishing, so the feature is still discoverable. */
  canMerge: boolean;
  /** Why merging is unavailable, shown on hover. */
  mergeHint?: string | null;
  onMerge: (beatNumber: number, direction: "up" | "down") => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const words = wordCount(beat.scriptSegment ?? "");
  const isShort = words > 0 && words <= SHORT_BEAT_WORDS;

  return (
    <div className="rounded-xl overflow-hidden transition-all"
      style={{ background: "var(--bg-panel)", border: `1px solid ${expanded ? "oklch(0.72 0.25 285 / 0.2)" : "var(--bd-7)"}` }}>
      <button
        className="w-full flex items-start gap-3 p-4 text-left transition-colors"
        style={{ background: expanded ? "oklch(0.72 0.25 285 / 0.04)" : "transparent" }}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 text-xs font-bold"
          style={{ background: "oklch(0.72 0.25 285 / 0.12)", color: "var(--brand-text)" }}>
          {beat.beatNumber}
        </span>
        <p className="text-sm flex-1 leading-relaxed line-clamp-2" style={{ color: "var(--c-60)" }}>
          {mode === "beats"
            ? beat.scriptSegment
            : beat.imagePrompt?.trim()
              ? beat.imagePrompt
              : <span className="italic" style={{ color: "var(--c-35)" }}>No image prompt yet</span>}
        </p>
        {mode === "beats" && isShort && !MERGE_BEATS_HIDDEN && (
          <span className="shrink-0 mt-0.5 px-2 py-0.5 rounded-full text-[10px] font-semibold whitespace-nowrap"
            style={{ background: "oklch(0.6 0.15 75 / 0.15)", color: "var(--accent-amber-text)", border: "1px solid oklch(0.6 0.15 75 / 0.3)" }}>
            {words} word{words === 1 ? "" : "s"}
          </span>
        )}
        <span className="text-xs shrink-0 mt-1" style={{ color: "var(--c-35)" }}>
          {expanded ? "▲" : "▼"}
        </span>
      </button>

      {expanded && (
        <div className="px-4 pb-4 space-y-4" style={{ borderTop: "1px solid var(--bd-6)" }}>
          {/* The segment is editable only until this beat has a prompt. After
              that the prompt, the render, the voiceover and the timings are all
              derived from it, and editing would leave them describing text that
              is no longer here — the same reason merging closes then. */}
          {mode === "beats" && (
          <div className="pt-3 rounded-lg px-3 py-2.5" style={{ background: "oklch(0.72 0.25 285 / 0.05)", border: "1px solid oklch(0.72 0.25 285 / 0.12)" }}>
            <p className="text-xs font-semibold uppercase tracking-wider mb-1" style={{ color: "oklch(0.6 0.15 75)" }}>
              Script Segment
            </p>
            {beat.imagePrompt?.trim() ? (
              <p className="text-sm leading-relaxed font-medium" style={{ color: "var(--c-85)" }}>{beat.scriptSegment}</p>
            ) : (
              <EditablePrompt
                value={beat.scriptSegment}
                field="segment"
                beatNumber={beat.beatNumber}
                projectId={projectId}
                onSaved={onSaved}
                accent="oklch(0.6 0.15 75)"
                textColor="var(--c-85)"
              />
            )}
          </div>
          )}

          {mode === "image" && (
          <div className="pt-3">
            <div className="flex items-center gap-1.5 mb-1.5">
              <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-45)" }}>
                Image Prompt
              </p>
              <CopyButton text={beat.imagePrompt} />
            </div>
            {consistencyPreview && (
              <div className="mb-2 rounded-lg px-3 py-2"
                style={{ background: "oklch(0.72 0.25 285 / 0.06)", border: "1px dashed oklch(0.72 0.25 285 / 0.3)" }}>
                <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: "var(--brand-text)" }}>
                  + Prefix (added before the prompt)
                </p>
                <p className="text-xs leading-relaxed" style={{ color: "var(--c-60)" }}>{consistencyPreview}</p>
              </div>
            )}
            <EditablePrompt
              value={beat.imagePrompt}
              field="image"
              beatNumber={beat.beatNumber}
              projectId={projectId}
              onSaved={onSaved}
              accent="oklch(0.72 0.25 285)"
              textColor="var(--c-75)"
            />
          </div>
          )}

          {mode === "image" && (
          <div className="flex gap-2 flex-wrap">
            {[
              { icon: "◎", label: beat.camera, key: "camera" },
              { icon: "◈", label: beat.lighting, key: "lighting" },
              { icon: "✦", label: beat.mood, key: "mood" },
              { icon: "▷", label: beat.action, key: "action" },
            ].filter((t) => t.label).map((tag) => (
              <span key={tag.key} className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs"
                style={{ background: "var(--bg-progress)", color: "var(--c-55)", border: "1px solid var(--bd-card)" }}>
                <span style={{ color: "var(--c-50)" }}>{tag.icon}</span>
                {tag.label}
              </span>
            ))}
          </div>
          )}

          {/* Merge lives on the Beats tab only — it is a decision about the
              narration, not about a prompt. */}
          {mode === "beats" && !(isFirst && isLast) && !MERGE_BEATS_HIDDEN && (
            <div className="flex items-center gap-2 pt-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider shrink-0" style={{ color: "var(--c-35)" }}>
                Merge
              </span>
              <span className="text-[9px] font-bold uppercase tracking-wide shrink-0" style={{ color: "oklch(0.65 0.24 25)" }}>
                New
              </span>
              {!isFirst && (
                <button
                  onClick={() => onMerge(beat.beatNumber, "up")}
                  disabled={!canMerge}
                  title={mergeHint ?? undefined}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs transition-all hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:opacity-40"
                  style={{ background: "var(--bg-progress)", color: "var(--c-60)", border: "1px solid var(--bd-card)" }}
                >
                  <ChevronUp size={12} />
                  into beat {beat.beatNumber - 1}
                </button>
              )}
              {!isLast && (
                <button
                  onClick={() => onMerge(beat.beatNumber, "down")}
                  disabled={!canMerge}
                  title={mergeHint ?? undefined}
                  className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs transition-all hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:opacity-40"
                  style={{ background: "var(--bg-progress)", color: "var(--c-60)", border: "1px solid var(--bd-card)" }}
                >
                  <ChevronDown size={12} />
                  with beat {beat.beatNumber + 1}
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Step card ──────────────────────────────────────────────────────────────

type StepStatus = "idle" | "running" | "done" | "error";

interface StepState {
  status: StepStatus;
  message: string;
  progress?: { current: number; total: number };
  /** Live tally of beats Claude has emitted within the current chunk,
   *  via the route's `chunk_beat_progress` SSE event. Resets on each
   *  new `progress` event (which fires when a chunk completes). */
  liveBeatsInChunk?: number;
  error?: string;
}

// Link inside the reroute modal, which is dark. Mirrors ExtLink on the Setup
// page. New tab on purpose: the user is mid-generation and navigating away
// would lose the failed run.
function ModalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      className="font-medium underline underline-offset-2 transition-opacity hover:opacity-80"
      style={{ color: "var(--brand-text)" }}>
      {children} ↗
    </a>
  );
}

interface StepCardProps {
  num: number;
  title: string;
  description: string;
  state: StepState;
  /** True when the server-side run is wrapping up after a Stop —
   *  visually we keep the running shell (progress bar, "Finishing the
   *  current section…" message) but hide the Stop button and treat the
   *  action button as a real, clickable "Resume" instead of a disabled
   *  "Running..." spinner. The card otherwise renders the same as
   *  status="running". */
  windingDown?: boolean;
  doneLabel?: string;
  /** Shown in the idle state when partial work was persisted (user
   *  stopped mid-run, or a prior error left beats behind). Lets the
   *  user see "138 ready, ~92 remaining" before clicking Resume.
   *  ReactNode (not string) so the caller can colour the "ready" half
   *  green and the "remaining" half orange in one composed label. */
  pendingLabel?: ReactNode;
  /** Rendered under the error text when the step has failed — an offer to
   *  change something about the failed attempt, rather than just retry it. */
  errorAction?: ReactNode;
  disabled?: boolean;
  optional?: boolean;
  /** Custom button label for non-running, non-done states (e.g. "Generate Remaining 9"). */
  actionLabel?: string | null;
  /** Renders the card without its action button — for a step whose work is
   *  currently produced by another step, so it reports state but cannot be
   *  run on its own. */
  hideAction?: boolean;
  /** Step-specific secondary action, rendered in the button row. Used to put
   *  "Merge beats" on the Beats step, where the decision actually belongs. */
  extraAction?: ReactNode;
  /** When set, renders a secondary "Clear" button. The handler should wipe persisted state for this step. */
  onClear?: (() => Promise<void> | void) | null;
  /** Stop handler — when set and the step is running, renders a Stop button alongside the spinner. */
  onStop?: (() => void | Promise<void>) | null;
  onGenerate: () => void;
}

// Rotating engagement caption shown on the right of a StepCard while a
// chunked generation is in flight. Pure UX — the messages are static
// strings cycled every ~2.4s so the card never looks frozen during a
// 30-60s chunk where neither the progress bar nor the live beat tally
// is ticking. Section number is derived from progress (which counts
// completed chunks, so current+1 is the chunk actually in flight).
const RUNNING_CAPTIONS = [
  "Studying the script",
  "Choosing camera angles",
  "Drafting visual cues",
  "Composing the next scene",
  "Shaping the mood",
  "Polishing the prompts",
  "Wiring the visuals",
];

function RunningCaption({ progress }: { progress?: { current: number; total: number } }) {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setIdx((i) => (i + 1) % RUNNING_CAPTIONS.length), 2400);
    return () => clearInterval(t);
  }, []);
  const sectionNum = progress ? Math.min(progress.current + 1, progress.total) : null;
  return (
    <div className="hidden md:flex flex-col items-end gap-1 max-w-[180px] mt-[15px]">
      {sectionNum !== null && progress && (
        <span className="text-[10px] font-semibold uppercase tracking-wider whitespace-nowrap"
          style={{ color: "oklch(0.65 0.15 75)" }}>
          Section {sectionNum} of {progress.total}
        </span>
      )}
      <span
        key={idx}
        className="text-[11px] italic text-right animate-pulse"
        style={{ color: "var(--c-50)" }}
      >
        {RUNNING_CAPTIONS[idx]}…
      </span>
    </div>
  );
}

function StepCard({ num, title, description, state, windingDown, doneLabel, pendingLabel, errorAction, disabled, optional, actionLabel, hideAction, extraAction, onClear, onStop, onGenerate }: StepCardProps) {
  const isRunning = state.status === "running";
  const isDone = state.status === "done";
  const isError = state.status === "error";

  // Time-based fake progress when the route doesn't emit real progress
  // events (single-chunk runs). Asymptotic curve so the bar never
  // visually stalls — even on long runs (multi-chunk image prompts,
  // KIE retries) it keeps creeping closer to 95% without ever pinning.
  // Time-to-target: ~50% at 45s, ~75% at 90s, ~95% at 3min.
  const RATE_CONSTANT_MS = 45000;
  const ASYMPTOTE = 95;
  const [fakePct, setFakePct] = useState(0);
  useEffect(() => {
    if (isDone) { setFakePct(100); return; }
    if (!isRunning) { setFakePct(0); return; }
    const startedAt = Date.now();
    setFakePct(0);
    const t = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      setFakePct(ASYMPTOTE * (1 - Math.exp(-elapsed / RATE_CONSTANT_MS)));
    }, 80);
    return () => clearInterval(t);
  }, [isRunning, isDone]);

  // Prefer real progress when the route reports it; else use fake.
  const realPct = state.progress
    ? Math.round((state.progress.current / state.progress.total) * 100)
    : null;
  const shownPct = realPct ?? Math.round(fakePct);

  const borderColor = isDone
    ? "oklch(0.55 0.15 145 / 0.25)"
    : isRunning
    ? "oklch(0.72 0.25 285 / 0.25)"
    : isError
    ? "oklch(0.6 0.22 25 / 0.3)"
    : "var(--bd-7)";

  const bg = isRunning ? "oklch(0.72 0.25 285 / 0.03)" : "var(--bg-panel)";

  return (
    <div className="rounded-xl p-4 flex flex-col sm:flex-row gap-3 sm:gap-4"
      style={{ background: bg, border: `1px solid ${borderColor}`, transition: "border-color 0.2s" }}>

      {/* Badge + content stay a row; the action buttons drop below them on
          mobile so the title/description (and the "optional" tag) aren't
          squeezed against the buttons. */}
      <div className="flex gap-4 flex-1 min-w-0">
      {/* Step badge */}
      <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0 text-sm font-bold mt-0.5"
        style={
          isDone ? { background: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.7 0.15 145)" } :
          isRunning ? { background: "oklch(0.72 0.25 285 / 0.12)", color: "var(--brand-text)" } :
          isError ? { background: "oklch(0.6 0.22 25 / 0.12)", color: "oklch(0.7 0.2 25)" } :
          { background: "var(--bg-progress)", color: "var(--c-30)" }
        }>
        {isDone ? "✓" : isError ? "✕" : isRunning
          ? <span className="block w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
          : num}
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <p className="text-sm font-semibold" style={{ color: disabled && !isDone ? "var(--c-35)" : "var(--c-85)" }}>
            {title}
          </p>
          {optional && (
            <span className="text-xs px-1.5 py-0.5 rounded"
              style={{ background: "var(--bg-progress)", color: "var(--c-35)" }}>
              optional
            </span>
          )}
        </div>

        <p className="text-xs mb-2" style={{ color: "var(--c-40)" }}>{description}</p>

        {/* Status line */}
        {isRunning && (
          <div className="space-y-1.5">
            <p className="text-xs" style={{ color: "oklch(0.65 0.15 75)" }}>{state.message}</p>
            <div className="flex items-center gap-2">
              <span className="text-xs shrink-0 tabular-nums font-mono"
                style={{ color: "oklch(0.7 0.15 145)" }}>
                {state.progress ? `${state.progress.current}/${state.progress.total}` : `${shownPct}%`}
              </span>
              <div className="flex-1 max-w-[260px] h-1 rounded-full overflow-hidden" style={{ background: "var(--bg-progress)" }}>
                <div className="h-full rounded-full transition-all duration-200"
                  style={{
                    width: `${shownPct}%`,
                    background: "oklch(0.55 0.15 145)",
                  }} />
              </div>
            </div>
          </div>
        )}
        {isDone && doneLabel && (
          <p className="text-xs" style={{ color: "oklch(0.6 0.15 145)" }}>{doneLabel}</p>
        )}
        {!isRunning && !isDone && !isError && pendingLabel && (
          <p className="text-xs">{pendingLabel}</p>
        )}
        {isError && (
          <div className="space-y-2">
            <p className="text-xs leading-relaxed" style={{ color: "oklch(0.65 0.15 25)" }}>{state.error}</p>
            {/* The question every failure raises is "did that just cost me
                money". KIE bills on completed generations, so attempts that
                fail (empty responses, relay 500s, rejected requests) are not
                charged. Worded as "attempts that fail" rather than a blanket
                "failed generations are free": a call that completes upstream
                and is then discarded on our side (schema mismatch, a write that
                lands nowhere) IS billed, and claiming otherwise would be a
                promise the cost ledger contradicts.

                Styled as an info card matching the beatsStale notice above, so
                it reads as reassurance sitting beside the error rather than as
                more of the error itself. */}
            <div className="rounded-xl px-3 py-2.5 flex items-start gap-2 text-[11px] leading-relaxed"
              style={{ background: "oklch(0.62 0.15 220 / 0.10)", border: "1px solid oklch(0.62 0.15 220 / 0.35)", color: "var(--c-60)" }}>
              <span aria-hidden>ⓘ</span>
              <span>
                <strong style={{ color: "var(--c-90)" }}>NOTE:</strong> Attempts that fail aren&apos;t charged.
                KIE only bills generations it completes, and prompts already saved are kept.
              </span>
            </div>
            {errorAction}
          </div>
        )}
      </div>
      </div>

      {/* Action buttons — a row beneath the content on mobile, a right
          column on desktop. Caption sits under the Stop button while
          running. */}
      <div className="shrink-0 flex flex-col items-start sm:items-end gap-2">
        <div className="flex items-start gap-2">
          {extraAction}
          {onClear && !isRunning && (
            <button
              onClick={() => { Promise.resolve(onClear()).catch(() => { /* surfaced via toast in caller */ }); }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-opacity"
              style={{ background: "transparent", color: "var(--c-50)", border: "1px solid var(--bd-8)" }}
            >
              Clear
            </button>
          )}
          {onStop && isRunning && !windingDown && (
            <button
              onClick={() => { Promise.resolve(onStop()).catch(() => { /* swallow — UI updates via state */ }); }}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-opacity hover:opacity-90"
              style={{ background: "oklch(0.6 0.22 25 / 0.1)", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}
            >
              Stop
            </button>
          )}
          {!hideAction && (
          <button
            onClick={onGenerate}
            disabled={disabled || (isRunning && !windingDown)}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-30 transition-opacity"
            style={
              isDone || isError
                ? { background: "var(--bg-progress)", color: "var(--c-50)", border: "1px solid var(--bd-8)" }
                : { background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }
            }
          >
            {(isRunning && !windingDown) ? "Running..." : (actionLabel ?? (windingDown ? "Resume" : isDone ? "Regenerate" : isError ? "Retry" : "Generate"))}
          </button>
          )}
        </div>
        {isRunning && <RunningCaption progress={state.progress} />}
      </div>
    </div>
  );
}

// ── SSE helper ─────────────────────────────────────────────────────────────

// Returns true when the server signaled `done`, false when the stream
// ended without one (truncated by a proxy, idle-timeout, etc.). The
// caller decides what to do — typically refetching project state and
// trusting the DB over the SSE channel.
async function streamStep(
  url: string,
  body: object,
  onUpdate: (s: StepState) => void,
  signal?: AbortSignal
): Promise<boolean> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) throw new Error(await res.text());
  if (!res.body) throw new Error("No response body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let doneReceived = false;
  // Snapshot of the current StepState we've published to the caller.
  // chunk_beat_progress events arrive between status/progress updates
  // and need to MERGE — losing message or progress.current here would
  // make the section counter blink off mid-chunk.
  let localState: StepState = { status: "running", message: "" };

  // Idle watchdog: if no bytes arrive for IDLE_MS, abort the reader and
  // exit. Some proxies leave the connection technically open but stop
  // forwarding data, which made reader.read() hang forever.
  const IDLE_MS = 60_000;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { reader.cancel().catch(() => {}); }, IDLE_MS);
  };
  resetIdle();

  // Progress watchdog. resetIdle() above fires on ANY bytes, including the
  // route's 15s ": keepalive" heartbeat, so it only catches a fully dead
  // connection — NOT a server that keeps heartbeating while making no real
  // progress (stuck KIE stream / wedged retry). That heartbeat-kept-alive
  // case is exactly what pinned the UI at 95% forever. This timer resets
  // ONLY when a real work event is parsed (below), ignoring heartbeats, so
  // a run that goes quiet for NO_PROGRESS_MS is surfaced as a resumable
  // stall. Healthy gaps are small — with concurrency some chunk is almost
  // always emitting beat ticks — so 4 min clears the worst realistic gap
  // (both in-flight chunks hitting the 120s server idle-abort at once, then
  // re-establishing) without riding the heartbeat indefinitely.
  const NO_PROGRESS_MS = 240_000;
  let stalled = false;
  let progressTimer: ReturnType<typeof setTimeout> | null = null;
  const resetProgress = () => {
    if (progressTimer) clearTimeout(progressTimer);
    progressTimer = setTimeout(() => { stalled = true; reader.cancel().catch(() => {}); }, NO_PROGRESS_MS);
  };
  resetProgress();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      resetIdle();

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const event = JSON.parse(line.slice(6));
          // Any parsed event is real work (heartbeats are ": keepalive"
          // lines, skipped above) — keep the stall watchdog at bay.
          resetProgress();
          if (event.type === "status") {
            // Status events drop progress + live count — they fire at
            // the start of the run before any chunk reports in.
            localState = { status: "running", message: event.message };
            onUpdate(localState);
          } else if (event.type === "progress") {
            // A new chunk just completed — bump section counters and
            // reset the live beat tally for the next chunk's stream.
            localState = {
              status: "running",
              message: `Section ${event.current} of ${event.total}`,
              progress: { current: event.current, total: event.total },
              liveBeatsInChunk: 0,
            };
            onUpdate(localState);
          } else if (event.type === "chunk_beat_progress") {
            // Per-beat tick during a chunk's Claude stream. Merge into
            // localState so message / progress survive the update.
            localState = { ...localState, liveBeatsInChunk: event.beatsInChunk };
            onUpdate(localState);
          } else if (event.type === "error") {
            throw new Error(event.message);
          } else if (event.type === "done") {
            doneReceived = true;
          }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
    if (progressTimer) clearTimeout(progressTimer);
  }

  // Progress watchdog cancelled the reader. Do NOT throw here — fall
  // through and let the caller's DB poll loop decide. The run may actually
  // have COMPLETED (current_state=14, all beats saved) with only the final
  // `done` SSE lost in the tail gap between the last beat and the hash
  // write; throwing would wrongly show "stalled" on a finished run. The
  // poll loop reconciles against the DB: shows done if complete, keeps
  // polling while the server is still active, or surfaces a resumable
  // error via its own (longer) watchdog if the run is genuinely dead.
  if (stalled) {
    console.warn("[prompts] stream progress watchdog fired — handing off to DB poll loop for reconciliation");
  }

  return doneReceived;
}

// Per-project prompt prefix (stored in the character_consistency_*
// columns, which predate the rename). A single statement placed in front
// of every image prompt at generation time. NULL text on the project row
// = inherit the account default (set in Settings); a value (including "")
// overrides it for this project only. Nothing here is baked into the
// stored beat prompts — it's applied only when a prompt is sent to the
// image generator, so edits take effect on the next generate without
// regenerating the prompts.
//
// Two controls: Save (writes the text and applies it) and Remove, which
// appears only when a prefix exists and clears it from the database. The
// old Add/Detach switch is gone — Save implies "apply".
function PrefixPanel({
  projectId,
  project,
  mutate,
  defText,
  onAccountSaved,
}: {
  projectId: string;
  project: { character_consistency_text?: string | null; character_consistency_append?: boolean | null } | undefined;
  mutate: () => void;
  /** Account-level default, shown as a placeholder while text inherits. */
  defText: string;
  /** Re-reads the account default after an all-videos save, so the
   *  placeholder and the per-beat preview reflect the new value. */
  onAccountSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  // null = inherit account default; string (incl. "") = per-project override.
  const [text, setText] = useState<string | null>(null);
  // true = append the text to prompts; false = detached (not applied).
  const [append, setAppend] = useState(true);
  const [hydrated, setHydrated] = useState(false);
  // Where Save writes: this project's row, or the account default that every
  // project inherits. Resets to "this" on each mount — promoting a prefix to
  // every video should be a deliberate click, never a sticky default.
  const [scope, setScope] = useState<"this" | "all">("this");
  // Set by Edit on the account-prefix view, so the editor replaces the
  // read-only block for the rest of this visit.
  const [editing, setEditing] = useState(false);

  // Seed the local editor from the project row once it lands.
  useEffect(() => {
    if (hydrated || !project) return;
    setText((project.character_consistency_text as string | null | undefined) ?? null);
    setAppend((project.character_consistency_append as boolean | null | undefined) ?? true);
    setHydrated(true);
  }, [project, hydrated]);

  async function persist(nextText: string | null, nextAppend: boolean, successMsg: string) {
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ character_consistency_text: nextText, character_consistency_append: nextAppend }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Save failed");
      }
      toast.success(successMsg);
      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  // "All videos" writes the text to the account default, then clears this
  // project's override so it inherits it — otherwise the project row would
  // keep shadowing the very default the user just set, and later edits to
  // the account default wouldn't reach this project.
  async function saveForAllVideos(next: string) {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ character_consistency_text: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Save failed");
      }
      const proj = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ character_consistency_text: null, character_consistency_append: true }),
      });
      if (!proj.ok) {
        const data = await proj.json().catch(() => ({}));
        throw new Error(data.error ?? "Saved for all videos, but this project kept its own prefix");
      }
      setText(null);
      setAppend(true);
      // Back to the read-only view, now showing the saved text.
      setEditing(false);
      toast.success("Prefix saved for all videos.");
      onAccountSaved();
      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  // Clear the project's stored prefix AND switch off application, then
  // persist both — so Remove takes the prefix out of the database rather
  // than only detaching it locally until the next Save. append:false is
  // what stops an inherited account default from taking over once the
  // project's own text is null (applyConsistency returns the base prompt
  // untouched when apply is false).
  async function remove() {
    setText(null);
    setAppend(false);
    await persist(null, false, "Prefix removed.");
  }

  // Clears the ACCOUNT default. Scoped wider than remove() above — this
  // takes the prefix off every project that inherits it, which is why the
  // button says so and the toast confirms the scope.
  async function removeAccountPrefix() {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ character_consistency_text: "" }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? "Remove failed");
      }
      setText(null);
      toast.success("Prefix removed from all videos.");
      onAccountSaved();
      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove");
    } finally {
      setSaving(false);
    }
  }

  const inputStyle = { background: "var(--bg-input)", border: "1px solid var(--bd-10)", color: "var(--c-90)" } as const;

  // Remove is offered only when a prefix actually exists, judged on the
  // SAVED row rather than the editor draft — otherwise merely typing would
  // surface a Remove button for a prefix that was never stored.
  const savedText = (project?.character_consistency_text as string | null | undefined) ?? null;
  const savedAppend = (project?.character_consistency_append as boolean | null | undefined) ?? true;
  const hasPrefix = savedAppend && (savedText ?? defText).trim().length > 0;

  // An account-scoped prefix this project is inheriting is shown as-is
  // rather than as an empty editor: there's nothing to add, only something
  // to change. The editor takes over once Edit is pressed.
  const accountPrefix = defText.trim();
  const showAccountPrefix = accountPrefix.length > 0 && savedText === null && !editing;

  // The pill's colour tracks whether a prefix is applied; the label reflects
  // whether there's one to change or one to add.
  const badge = showAccountPrefix ? "Prefix" : "Add prefix";

  // Nothing to save while the field holds no override (null = inheriting)
  // or while the draft still matches what's stored. For "all videos" the
  // comparison is against the account default instead, and an existing
  // project override counts as work to do (it has to be cleared).
  const draft = (text ?? "").trim();
  // Checked on both scopes: "all videos" writes the account default, which is
  // the same field the Setup page guards.
  const overBy = draft.length - PREFIX_MAX_CHARS;
  const canSave = scope === "all"
    ? draft.length > 0 && (draft !== defText.trim() || savedText !== null)
    : text !== null && text !== savedText;

  return (
    <div className="rounded-xl overflow-hidden self-start w-full"
      style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-card)" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors"
      >
        {/* No title on the left — the badge is the only header label, so it
            doubles as the affordance for opening the panel. */}
        <span className="text-[10px] px-3 py-1.5 rounded-full"
          style={append
            ? { background: "oklch(0.72 0.25 285 / 0.15)", color: "var(--accent-purple-text)", border: "1px solid oklch(0.72 0.25 285 / 0.4)" }
            : { background: "var(--bg-panel)", color: "var(--c-45)", border: "1px solid var(--bd-card)" }}>
          {badge}
        </span>
        <span className="text-[9px] font-bold uppercase tracking-wide" style={{ color: "oklch(0.65 0.24 25)" }}>
          New
        </span>
        <span className="ml-auto" style={{ color: "var(--c-45)" }}>
          {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {open && showAccountPrefix && (
        <div className="px-3 pb-3 space-y-3" style={{ borderTop: "1px solid var(--bd-card)" }}>
          <p className="text-[11px] leading-relaxed pt-3" style={{ color: "var(--c-45)" }}>
            Leads every image prompt, on all videos.
          </p>

          <p className="px-3 py-2 rounded-lg text-xs leading-relaxed whitespace-pre-wrap"
            style={{ background: "var(--bg-input)", border: "1px solid var(--bd-10)", color: "var(--c-90)" }}>
            {accountPrefix}
          </p>

          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={() => { setText(accountPrefix); setScope("all"); setEditing(true); }}
              disabled={saving}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-50"
              style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
            >
              Edit
            </button>
            <button
              onClick={removeAccountPrefix}
              disabled={saving}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80 disabled:opacity-50"
              style={{ background: "transparent", color: "var(--c-55)", border: "1px solid var(--bd-card)" }}
            >
              {saving ? "Removing…" : "Remove"}
            </button>
            <span className="text-[10px]" style={{ color: "var(--c-42)" }}>
              Remove takes it off every video.
            </span>
          </div>
        </div>
      )}

      {open && !showAccountPrefix && (
        <div className="px-3 pb-3 space-y-3" style={{ borderTop: "1px solid var(--bd-card)" }}>
          <p className="text-[11px] leading-relaxed pt-3" style={{ color: "var(--c-45)" }}>
            Leads every image prompt from the next generation on. Blank
            uses your account default.
          </p>

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <label className="text-[11px] font-medium" style={{ color: "var(--c-50)" }}>Prefix text</label>
              <span className="text-[10px] font-mono tabular-nums"
                style={{ color: overBy > 0 ? "oklch(0.65 0.24 25)" : "var(--c-42)" }}>
                {draft.length} / {PREFIX_MAX_CHARS}
              </span>
            </div>
            {/* Always editable. With the Add button gone there's no switch
                to turn application back on, so disabling this while removed
                would leave no route back to having a prefix — Save is that
                route, and it re-applies. */}
            <textarea
              value={text ?? ""}
              onChange={(e) => setText(e.target.value)}
              rows={7}
              placeholder={text === null && defText ? `Inheriting: ${defText}` : "Text placed in front of every image prompt…"}
              className="w-full px-3 py-2 rounded-lg text-xs outline-none transition-all resize-y"
              style={inputStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = "oklch(0.72 0.25 285 / 0.5)"; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-10)"; }}
            />
          </div>

          {/* Scope switch. "All videos" promotes the text to the account
              default, so it leads prompts on every project instead of just
              this one. */}
          <div className="flex items-center justify-center gap-2.5 py-0.5">
            <span className="text-[11px] font-medium" style={{ color: "var(--c-45)" }}>For:</span>
            <button
              onClick={() => setScope("this")}
              disabled={saving}
              className="text-[11px] font-medium transition-colors disabled:opacity-50"
              style={{ color: scope === "this" ? "var(--accent-purple-text)" : "var(--c-45)" }}
            >
              This video
            </button>
            <button
              onClick={() => setScope(scope === "this" ? "all" : "this")}
              disabled={saving}
              role="switch"
              aria-checked={scope === "all"}
              aria-label="Apply this prefix to all videos"
              className="relative rounded-full transition-all shrink-0 disabled:opacity-50"
              style={{
                width: 34,
                height: 18,
                background: scope === "all" ? "oklch(0.72 0.25 285)" : "var(--bg-panel)",
                border: "1px solid var(--bd-card)",
              }}
            >
              <span
                className="absolute rounded-full transition-all"
                style={{
                  width: 12,
                  height: 12,
                  top: 2,
                  left: scope === "all" ? 18 : 3,
                  background: scope === "all" ? "white" : "var(--c-45)",
                }}
              />
            </button>
            <button
              onClick={() => setScope("all")}
              disabled={saving}
              className="text-[11px] font-medium transition-colors disabled:opacity-50"
              style={{ color: scope === "all" ? "var(--accent-purple-text)" : "var(--c-45)" }}
            >
              All videos
            </button>
          </div>

          {overBy > 0 && (
            <p className="text-[11px] leading-relaxed" style={{ color: "oklch(0.65 0.24 25)" }}>
              {overBy.toLocaleString()} characters too long. A prefix is a short
              style note that leads every prompt, not a script. Describe only
              what should never change, such as the look, the palette and a
              recurring character, and leave each scene to Heclus.
            </p>
          )}

          {scope === "all" && overBy <= 0 && (
            <p className="text-[11px] leading-relaxed" style={{ color: "var(--brand-text)" }}>
              Saves as your account default, so it leads prompts on every
              project. This project stops keeping its own copy and follows the
              default from here on.
            </p>
          )}

          <div className="flex items-center gap-2 flex-wrap">
            {/* Saving always re-applies the prefix (append:true) — it's the
                only way back after a Remove. */}
            <button
              onClick={() => scope === "all"
                ? saveForAllVideos(draft)
                : persist(text, true, "Prefix saved for this project.")}
              disabled={saving || !canSave || overBy > 0}
              title={overBy > 0 ? `Trim ${overBy.toLocaleString()} characters to save` : undefined}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-50"
              style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {hasPrefix && (
              <button
                onClick={remove}
                disabled={saving}
                className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80 disabled:opacity-50"
                style={{ background: "transparent", color: "var(--c-55)", border: "1px solid var(--bd-card)" }}
              >
                {saving ? "Removing…" : "Remove"}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

type Tab = "beats" | "image" | "video";

interface PageProps {
  params: { projectId: string };
}

const IDLE: StepState = { status: "idle", message: "" };

// Window for showing the "still finishing the in-flight section…"
// spinner after the user clicks Stop. Chosen well above the typical
// chunk wall time (8-15s for video, 30-60s for image) so a slow chunk
// still has the spinner visible when it lands. After this elapses we
// hide the spinner even if no new beats showed up — likely means the
// chunk errored and won't persist; the user can click Resume.
const STOP_GRACE_MS = 90_000;

export default function PromptsPage({ params }: PageProps) {
  const { projectId } = params;
  const router = useRouter();
  const { project, mutate } = useProject(projectId);

  // Account-level character-consistency default, fetched once. Feeds both
  // the per-project panel (placeholder) and the per-beat "will be
  // appended" preview so the user can see what gets added at generation.
  const [accountConsistencyText, setAccountConsistencyText] = useState("");
  const refreshAccountConsistency = useCallback(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => setAccountConsistencyText((data?.character_consistency_text as string) ?? ""))
      .catch(() => {});
  }, []);
  useEffect(() => { refreshAccountConsistency(); }, [refreshAccountConsistency]);

  const refreshAnthropicRouting = useCallback(() => {
    fetch("/api/me/anthropic-routing")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (d && !d.error) setAnthropicRouting(d); })
      .catch(() => { /* the offer just stays hidden */ });
  }, []);
  useEffect(() => { refreshAnthropicRouting(); }, [refreshAnthropicRouting]);
  // Effective text that will be appended to every image prompt for this
  // project: per-project override if set, else the account default —
  // unless the project has detached it. NULL = nothing appended.
  const projConsistencyText = project?.character_consistency_text as string | null | undefined;
  const projConsistencyAppend = (project?.character_consistency_append as boolean | null | undefined) ?? true;
  const effectiveConsistency = (projConsistencyText ?? accountConsistencyText ?? "").trim();
  const consistencyPreview = projConsistencyAppend && effectiveConsistency ? effectiveConsistency : null;

  // Bump current_state to 13 the first time the user lands here so the
  // Visuals phase ticks done in the WizardNav. The visuals phase's
  // states array tops out at 12, but visual-analysis only bumps to 9
  // — leaving Visuals visually locked when the user is past it. State
  // 13 keeps the project past the Visuals "done" threshold without
  // crossing into Generate/Assemble territory.
  useEffect(() => {
    const reached = project?.current_state as number | undefined;
    if (reached !== undefined && reached < 13) {
      fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_state: 13 }),
      }).then(() => mutate()).catch(() => { /* non-blocking */ });
    }
  }, [project?.current_state, projectId, mutate]);

  // Segmentation-only run (three-step flow). Its own state because card 1
  // finishes long before card 2 starts, and a beats failure must not read as
  // an image-prompts failure.
  const [beatsStep, setBeatsStep] = useState<StepState>(IDLE);
  const [imageStep, setImageStep] = useState<StepState>(IDLE);
  const [videoStep, setVideoStep] = useState<StepState>(IDLE);
  // "User clicked Stop on this step" sticky flag. Pure UX state — overrides
  // the derived `effectiveImage`/`effectiveVideo` "done" branch so the user
  // sees Clear + Resume after a stop, not Clear + Regenerate, even when
  // the route happened to write `current_state >= 14` before the abort
  // landed. Cleared the moment the user picks an explicit next action
  // (Resume kicks off a new run; Clear wipes state).
  const [beatsStoppedByUser, setBeatsStoppedByUser] = useState(false);
  // The user has looked at the beats and chosen to move on. Steps 2 and 3 stay
  // locked until then: writing a prompt is what makes a merge expensive, so the
  // decision to stop merging should be deliberate rather than implied by the
  // split finishing. Not persisted — a project that already has prompts is
  // past this gate anyway (see beatsGateOpen), so the only cost is one extra
  // click if the page is reloaded between splitting and continuing.
  const [beatsConfirmed, setBeatsConfirmed] = useState(false);
  const [continueOpen, setContinueOpen] = useState(false);
  // Whether this client can move their Claude calls off KIE onto their own
  // Anthropic key, and whether they already have. Drives the reroute offer that
  // appears on a failed generation — see anthropicOffer below.
  const [anthropicRouting, setAnthropicRouting] = useState<{
    hasKey: boolean;
    enabled: boolean;
    eligible: { image_prompts: boolean; video_prompts: boolean };
  } | null>(null);
  // Which step the reroute offer was clicked from, so the retry after switching
  // runs the step that actually failed. null = modal closed.
  const [rerouteFor, setRerouteFor] = useState<"beats" | "image" | "video" | null>(null);
  const [anthropicKeyDraft, setAnthropicKeyDraft] = useState("");
  const [switchingRoute, setSwitchingRoute] = useState(false);
  const [imageStoppedByUser, setImageStoppedByUser] = useState(false);
  const [videoStoppedByUser, setVideoStoppedByUser] = useState(false);
  // Snapshot of the persisted beat count at the moment the user clicked
  // Stop, plus the time the click happened. While the in-flight chunk
  // is still wrapping up server-side (route lets it complete and
  // persist — see route.ts processChunk for video), the UI shows a
  // spinner + "Finishing the current section…" caption next to the
  // partial label so the user knows the visible counts will tick up
  // shortly. Cleared when either (a) the snapshot count is exceeded
  // by SWR-refreshed beats (chunk landed) or (b) STOP_GRACE_MS
  // elapses (safety net for a chunk that errored out and never
  // persisted). Also cleared on Resume.
  const [imageStopState, setImageStopState] = useState<{ stoppedAt: number; snapshot: number } | null>(null);
  const [videoStopState, setVideoStopState] = useState<{ stoppedAt: number; snapshot: number } | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>("beats");
  const [exportingDocx, setExportingDocx] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  // Which prompt kinds go into the export. Both on = the whole set; the
  // format buttons are disabled while neither is ticked.
  const [exportImage, setExportImage] = useState(true);
  const [exportVideo, setExportVideo] = useState(true);
  const [navigating, setNavigating] = useState(false);
  // Image prompt style — General is the current behaviour; Cinematic
  // adds filmic cues on top of the visual profile at generation time.
  // Initialised from the persisted column, and any user click through
  // the tab bar PATCHes it back so a reload keeps the choice.
  const [promptStyle, setPromptStyleLocal] = useState<"general" | "cinematic">(
    (project?.prompt_style as "general" | "cinematic" | undefined) ?? "general",
  );
  // Sync when the project row lands (first fetch on mount, or a
  // background refresh). Never override an active user change: the
  // click handler always runs the PATCH before the SWR re-hydration
  // arrives, so we only trust the row when the local state matches
  // its old value (i.e. we haven't set anything different yet).
  useEffect(() => {
    const remote = (project?.prompt_style as "general" | "cinematic" | undefined) ?? "general";
    setPromptStyleLocal((prev) => (prev === remote ? prev : prev === "general" && remote !== "general" ? remote : prev));
    // Only when the local state is still the default and the row has
    // a value do we adopt it — this prevents a "server said general"
    // response from bouncing a fresh Cinematic click back to General.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.prompt_style]);

  async function setPromptStyle(next: "general" | "cinematic") {
    if (next === promptStyle) return;
    setPromptStyleLocal(next);
    try {
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt_style: next }),
      });
      mutate();
    } catch { /* best-effort — the next generate click still sends the current selection */ }
  }

  // Download every beat's image + video prompt. Both formats hit the same
  // scope:"prompts" export, so the file holds only the prompts — not the
  // ideas/script/thumbnail sections the Generate step's full export has.
  async function exportPrompts(format: "pdf" | "docx") {
    setExportMenuOpen(false);
    setExportingDocx(true);
    try {
      const res = await fetch(`/api/export/${format}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          scope: "prompts",
          parts: { image: exportImage, video: exportVideo },
        }),
      });
      if (!res.ok) throw new Error((await res.text().catch(() => "")) || "Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      // Mirrors the server's filenameBase — a blob download takes its name
      // from here, not from Content-Disposition.
      const suffix = exportImage && exportVideo
        ? "prompts"
        : exportImage ? "image_prompts" : "video_prompts";
      a.download = `${(project?.channel_name ?? "export").replace(/\s+/g, "_")}_${suffix}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setExportingDocx(false);
    }
  }
  // Per-step AbortControllers so the user's Stop click can kill the
  // local SSE fetch alongside the server-side run-id PATCH. Without
  // the abort the fetch keeps the connection open until the server
  // closes it (a few seconds later when its next assertPromptsRunActive
  // fires); the abort makes the UI snap to "stopped" instantly.
  const beatsAbortRef = useRef<AbortController | null>(null);
  const imageAbortRef = useRef<AbortController | null>(null);
  const videoAbortRef = useRef<AbortController | null>(null);
  // Scroll container for the floating jump-to buttons — the per-beat prompt
  // list below can run to hundreds of cards. Mirrors the voiceover step.
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const [clearTarget, setClearTarget] = useState<"image" | "video" | null>(null);
  const [clearing, setClearing] = useState(false);
  const [regenTarget, setRegenTarget] = useState<"image" | "video" | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [mergeTarget, setMergeTarget] = useState<{ beatNumber: number; direction: "up" | "down" } | null>(null);
  const [mergeDraft, setMergeDraft] = useState("");
  const [merging, setMerging] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkMinWords, setBulkMinWords] = useState(SHORT_BEAT_WORDS);
  const [bulkDirection, setBulkDirection] = useState<"up" | "down" | "auto">("up");
  const [bulkRunning, setBulkRunning] = useState(false);

  const beats: Beat[] = project?.beats ?? [];
  const videoBeats = beats.filter((b) => b.videoPrompt);

  // Clear the stop-grace snapshot once the in-flight chunk lands
  // (current beats outnumber the snapshot — SWR polls every 5s).
  // Image step uses total beats; video step uses video-prompted beats.
  // If the chunk landing also closes out the run (every beat now has
  // its prompt), also clear the user-stopped sticky so the StepCard
  // can transition from "Resume" → "Done" instead of looking frozen
  // in the stopped state. mutate() is called for a fresh re-read so
  // any derived server fields (e.g. current_state for image) catch
  // up immediately without waiting another SWR tick.
  useEffect(() => {
    if (imageStopState && beats.length > imageStopState.snapshot) {
      setImageStopState(null);
      void mutate();
      if (beats.length > 0 && beats.every((b) => !!b.imagePrompt)) {
        setImageStoppedByUser(false);
      }
    }
  }, [beats, beats.length, imageStopState, mutate]);
  useEffect(() => {
    if (videoStopState && videoBeats.length > videoStopState.snapshot) {
      setVideoStopState(null);
      void mutate();
      if (beats.length > 0 && videoBeats.length === beats.length) {
        setVideoStoppedByUser(false);
      }
    }
  }, [videoBeats.length, videoStopState, beats.length, mutate]);

  // Safety net: hide the spinner after STOP_GRACE_MS even if no new
  // beats arrived (the in-flight chunk errored out and won't persist).
  // The user can click Resume to retry from where we left off.
  useEffect(() => {
    if (!imageStopState) return;
    const t = setTimeout(() => setImageStopState(null), STOP_GRACE_MS);
    return () => clearTimeout(t);
  }, [imageStopState]);
  useEffect(() => {
    if (!videoStopState) return;
    const t = setTimeout(() => setVideoStopState(null), STOP_GRACE_MS);
    return () => clearTimeout(t);
  }, [videoStopState]);

  const hasImageBeats = beats.length > 0;
  const hasVideoBeats = videoBeats.length > 0;

  // Remaining-work counts for resume labels. Both stages are resumable
  // server-side (per-chunk DB writes), so on any failure — including
  // credit/quota limits or upstream 500s — the retry picks up from
  // where we left off. The action label always reflects that, even
  // when zero work has been saved yet (first-chunk failure).
  const videoRemaining = beats.length > 0 ? beats.length - videoBeats.length : 0;
  // Video step's resume / pending UX mirrors the image side. Resumable
  // when (a) there are partial video prompts and image beats still
  // exist to anchor against, or (b) the user explicitly clicked Stop
  // — even with zero video prompts yet, the in-flight chunk will
  // persist (mirror of the image-side guarantee) and Resume must be
  // visible so they can pick the work back up.
  const videoStepResumable =
    (hasImageBeats && videoRemaining > 0 && hasVideoBeats) || videoStoppedByUser;
  // Video resume requires image beats to actually exist on the server.
  // If they were cleared or never generated, fall back to the plain
  // "Retry" so users don't fire a request that can't possibly succeed.
  const videoActionLabel = videoStep.status === "error" && videoRemaining > 0 && hasImageBeats
    ? `Generate Remaining ${videoRemaining}`
    : (videoStepResumable && videoStep.status === "idle")
    ? "Resume"
    : null;
  // Status line for the stopped / partial state — exact counts here
  // (unlike image which estimates from script word count) because the
  // total is known: it's the number of image beats. Three flavors,
  // matching imagePendingLabel:
  //  • no video prompts yet (Stop fired before any chunk landed) →
  //    "0 ready, first segment still processing"
  //  • partial video prompts → "X ready, Y remaining"
  //  • totals unknown (no image beats at all) → bare "X ready"
  // The "ready" half renders green to mirror the doneLabel colour
  // (same green as the StepCard's done state), the "remaining" half
  // stays in the warm pendingLabel orange. When the user just clicked
  // Stop, a spinner + "Finishing the current section…" caption is
  // appended (gap 40px) so they know the in-flight chunk's beats are
  // still inbound — see videoStopState above.
  const videoInFlightStillRunning = videoStopState !== null;
  const inFlightIndicator = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: "8px", color: "var(--c-50)" }}>
      <span className="inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" aria-hidden />
      <span>Finishing the current section…</span>
    </span>
  );
  const videoPendingLabel: ReactNode = videoStepResumable
    ? !hasVideoBeats
      ? <span style={{ display: "inline-flex", alignItems: "center", gap: "40px", flexWrap: "wrap" }}>
          <span style={{ color: "oklch(0.65 0.15 75)" }}>
            {videoInFlightStillRunning
              ? "0 ready, first segment still processing"
              : "0 ready. The last attempt did not finish. Click Generate to retry."}
          </span>
          {videoInFlightStillRunning && inFlightIndicator}
        </span>
      : beats.length > 0
        ? <span style={{ display: "inline-flex", alignItems: "center", gap: "40px", flexWrap: "wrap" }}>
            <span>
              <span style={{ color: "oklch(0.6 0.15 145)" }}>{`${videoBeats.length} ready`}</span>
              <span style={{ color: "oklch(0.65 0.15 75)" }}>{`, ${videoRemaining} remaining`}</span>
            </span>
            {videoInFlightStillRunning && inFlightIndicator}
          </span>
        : <span style={{ display: "inline-flex", alignItems: "center", gap: "40px", flexWrap: "wrap" }}>
            <span style={{ color: "oklch(0.6 0.15 145)" }}>{`${videoBeats.length} ready`}</span>
            {videoInFlightStillRunning && inFlightIndicator}
          </span>
    : undefined;

  // Server-side run flag — set when ANY prompts generation is in flight
  // (image OR video). On a fresh page load after refresh/nav-away, local
  // step state is "idle" but project.prompts_active_run_id is still
  // populated by the running route; surface that as "running" so the
  // user sees a spinner instead of an idle StepCard with a Generate
  // button they could accidentally double-click.
  const remoteRunInProgress = !!project?.prompts_active_run_id;
  // True from the moment the user clicks Stop until the server's worker
  // pool exits and releasePromptsRunIfOwned clears the flag (alongside
  // run_id). While set, the active step is winding down — the running
  // indicator's message switches to "Finishing the current section…"
  // so the user doesn't see a misleading "Generating — N more" line.
  const promptsStopRequested = !!project?.prompts_stop_requested;
  // The route writes prompts_active_step alongside the run id ("images"
  // or "videos") so the client can identify which step actually owns the
  // active run after a page refresh. Without this, a video run on
  // partial image beats was misclassified as an image resume — image
  // beats incomplete + run id set used to be sufficient to flag the
  // image step as running.
  // "fill" is the three-step flow's image-prompts run and belongs to the same
  // card as "images"; "beats" is card 1's segmentation run.
  const remoteStep = (project?.prompts_active_step as "beats" | "fill" | "images" | "videos" | null | undefined) ?? null;
  // True image-step completion lives in `current_state >= 14` — the route
  // only writes that after the final chunk finishes and every beat has
  // an image_prompt. `beats.every(b => !!b.imagePrompt)` alone is NOT a
  // safe completion signal: mid-run, the chunks that already persisted
  // each carry their imagePrompt, so `every` is trivially true the moment
  // chunk 1 lands and the UI would otherwise flip to "done" while the
  // server is still working on chunks 2..N.
  const imageStepCompleteOnServer =
    (project?.current_state ?? 0) >= 14
    && hasImageBeats
    && beats.every((b) => !!b.imagePrompt);
  // Symmetric check for the video step. Without this the effectiveVideo
  // fallback (below) treated *any* video beat as full completion and
  // hid the "N generated, M remaining" pendingLabel on page refresh
  // after a partial Stop — the StepCard would show "X beats ready"
  // instead of the partial-progress label the image step shows. True
  // completion = there's an image beat for every video beat AND every
  // image beat has a video prompt. Video step doesn't touch
  // current_state (only the image step does), so the gate is just
  // counts + presence.
  const videoStepCompleteOnServer =
    hasImageBeats
    && hasVideoBeats
    && videoBeats.length === beats.length;
  // No local activity but a server run is going AND the active step is
  // image → the image route is the one running. SWR's 5s refresh
  // eventually clears this when the run finishes and the route nulls
  // prompts_active_run_id + prompts_active_step.
  const imageRemoteRunning =
    remoteRunInProgress
    && (remoteStep === "images" || remoteStep === "fill")
    && beatsStep.status === "idle" && imageStep.status === "idle" && videoStep.status === "idle";
  const beatsRemoteRunning =
    remoteRunInProgress && remoteStep === "beats"
    && beatsStep.status === "idle" && imageStep.status === "idle" && videoStep.status === "idle";
  // Symmetric flag for the video step. Re-introduced safely now that
  // prompts_active_step disambiguates which run is going — previously
  // we couldn't derive this without false positives.
  const videoRemoteRunning =
    remoteRunInProgress && remoteStep === "videos"
    && beatsStep.status === "idle" && imageStep.status === "idle" && videoStep.status === "idle";

  // Estimate the target beat count from the script's word count so the
  // image-step progress bar can show actual progress on reconnect
  // instead of restarting at 0. The prompt instructs Claude to produce
  // roughly one beat per 12 words of narration; this is approximate
  // (a long-form script will land anywhere in the 10–15 words/beat
  // range) but it's enough to give the user a meaningful "halfway
  // there" instead of "starting from scratch". Capped so the visible
  // percentage never claims to be more than 99% before the actual
  // done signal flips the card to its done state.
  const scriptWords = (project?.word_count as number | undefined) ?? 0;
  const estimatedTotalBeats = scriptWords > 0 ? Math.max(1, Math.ceil(scriptWords / 12)) : 0;
  // In the three-step flow the estimate is unnecessary: the beats already
  // exist, so the total is exactly beats.length and the work done is the
  // number of them carrying a prompt. Counting beats instead — as the
  // combined pass must, since it creates them as it goes — would read as
  // "done" from the first moment, because every beat is already there.
  const fillMode = PROMPTS_THREE_STEP && hasImageBeats;
  const promptedBeats = beats.filter((b) => !!b.imagePrompt).length;
  const imageTotal = fillMode ? beats.length : estimatedTotalBeats;
  const imageWritten = fillMode ? promptedBeats : beats.length;
  const imageProgress = imageTotal > 0
    ? { current: Math.min(imageWritten, imageTotal - 1), total: imageTotal }
    : undefined;

  // Partial work the user can resume — beats already persisted but the
  // step never reached the server's "complete" mark (current_state >= 14),
  // OR the user explicitly clicked Stop (we honour their intent even if
  // a racing completion check inside the route had already flipped
  // current_state to 14). The route's chunk walk natively resumes
  // (skips chunks already covered by existing beats), so clicking
  // Resume just continues from where the last run left off — no
  // destructive regenerate needed.
  // Resumable covers three cases:
  //  (1) Partial beats persisted + step not server-complete (normal
  //      mid-run Stop with some chunks done).
  //  (2) User clicked Stop — regardless of whether beats landed yet.
  //      Even with 0 beats, the in-flight chunk Claude was working on
  //      will still persist (the route no longer asserts-active
  //      between Claude completion and DB insert) and the user needs
  //      a Resume button to pick the work back up.
  //  (3) Step had previously completed but the user stopped a regen
  //      mid-flight (imageStoppedByUser flips on then).
  // In fill mode the presence of beats says nothing about this step — beats
  // are card 1's output and exist before card 2 has ever run. What's
  // resumable there is PARTIAL prompts.
  const imageStepResumable = fillMode
    ? (promptedBeats > 0 && !imageStepCompleteOnServer) || imageStoppedByUser
    : (hasImageBeats && !imageStepCompleteOnServer) || imageStoppedByUser;
  const imageActionLabel = imageStep.status === "error"
    ? "Resume"
    : (imageStepResumable && imageStep.status === "idle")
    ? "Resume"
    : null;

  // When the step is resumable surface a status line so the user can
  // see the work-so-far before deciding Resume vs Clear. Three flavors:
  //  • beats persisted → "N ready, ~M remaining"
  //  • stopped before any beats landed, in-flight chunk likely still
  //    finishing server-side → "0 ready, first segment still
  //    processing". SWR's 5s poll picks up the chunk's beats when
  //    they land and the label flips to the first variant.
  //  • no script word_count yet → bare "N ready"
  // estimatedTotalBeats is approximate (~1 beat per 12 script words),
  // so the remaining count is prefixed with "~" — accurate enough to
  // be useful, honest enough not to mislead. The "ready" half is green
  // (matches the doneLabel colour); the "remaining" half stays orange.
  // Same in-flight indicator logic as the video step (see comment
  // above videoPendingLabel) — when the user just clicked Stop the
  // last image chunk is still wrapping up server-side and persisting
  // its beats; show the spinner + caption so the user knows the
  // counts will tick up shortly.
  const imageInFlightStillRunning = imageStopState !== null;
  const imagePendingLabel: ReactNode = imageStepResumable
    ? !hasImageBeats
      ? <span style={{ display: "inline-flex", alignItems: "center", gap: "40px", flexWrap: "wrap" }}>
          <span style={{ color: "oklch(0.65 0.15 75)" }}>
            {imageInFlightStillRunning
              ? "0 ready, first segment still processing"
              : "0 ready. The last attempt did not finish. Click Generate to retry."}
          </span>
          {imageInFlightStillRunning && inFlightIndicator}
        </span>
      : imageTotal > 0
        // No "~" in fill mode: the total is the beat count, not an estimate.
        ? <span style={{ display: "inline-flex", alignItems: "center", gap: "40px", flexWrap: "wrap" }}>
            <span>
              <span style={{ color: "oklch(0.6 0.15 145)" }}>{`${imageWritten} ready`}</span>
              <span style={{ color: "oklch(0.65 0.15 75)" }}>{`, ${fillMode ? "" : "~"}${Math.max(0, imageTotal - imageWritten)} remaining`}</span>
            </span>
            {imageInFlightStillRunning && inFlightIndicator}
          </span>
        : <span style={{ display: "inline-flex", alignItems: "center", gap: "40px", flexWrap: "wrap" }}>
            <span style={{ color: "oklch(0.6 0.15 145)" }}>{`${imageWritten} ready`}</span>
            {imageInFlightStillRunning && inFlightIndicator}
          </span>
    : undefined;

  // Derive effective step state: prefer live state, then server-side
  // remote run, then DB presence. The "running" branch here only fires
  // on refresh / nav-away → return; in that case we synthesize a fresh
  // running state with real progress derived from the persisted beat
  // count so the user sees actual work instead of an idle bar.
  // Failure of the last run, persisted server-side so a reload still explains
  // it. Scoped per step because the run id is gone by the time we read this.
  const persistedError = (project as { prompts_last_error?: string | null } | undefined)?.prompts_last_error ?? null;
  const persistedErrorStep = (project as { prompts_last_error_step?: string | null } | undefined)?.prompts_last_error_step ?? null;
  // "fill" is card 2's run in the three-step flow, so its failures belong to
  // the image card.
  const persistedImageError = persistedErrorStep === "images" || persistedErrorStep === "fill" ? persistedError : null;
  const persistedVideoError = persistedErrorStep === "videos" ? persistedError : null;
  const persistedBeatsError = persistedErrorStep === "beats" ? persistedError : null;

  // A split that never finished. generateBeats writes prompts_script_hash only
  // on its success path, so beats with no hash are a partial walk. Restricted
  // to projects with no prompts yet: a two-step project has beats AND prompts,
  // and some predate the hash column entirely — without that guard every one
  // of them would read as a half-done split. A hash that is merely out of DATE
  // is a different condition — that's the "script was edited" warning below.
  const beatsIncomplete =
    PROMPTS_THREE_STEP && beats.length > 0 && promptedBeats === 0 && !project?.prompts_script_hash;

  // Card 1's state. Completion is derived only from data that already exists —
  // beats with segments — so every finished project reads as complete and
  // nothing needs backfilling. The combined pass creates beats as it goes, so
  // while it runs with none saved yet, card 1 is what's working.
  const beatsStepState: StepState =
    beatsStep.status !== "idle" ? beatsStep :
    beatsRemoteRunning ? {
      status: "running",
      message: promptsStopRequested
        ? "Finishing the current section…"
        : "Splitting the script in the background",
    } :
    imageStep.status === "running" && beats.length === 0 ? { status: "running", message: "Splitting the script…" } :
    persistedBeatsError ? { status: "error", message: "", error: persistedBeatsError } :
    beats.length > 0 && !beatsIncomplete && !beatsStoppedByUser ? { status: "done", message: "" } : IDLE;

  // Card 1 offers an action when there is nothing yet (Generate), and when the
  // last attempt failed, was stopped, or left the walk partial (Resume).
  // Never once the split is complete: re-splitting deletes the beat rows and
  // takes the paid prompts, renders and voiceovers with them.
  const beatsResumable = beatsIncomplete || beatsStoppedByUser || beatsStepState.status === "error";
  // Gate for the two cards downstream. Card 1 reaching "done" is the only
  // state that means the whole script is split — it already excludes a run in
  // flight, a partial walk, a stop and a failure, each of which would let the
  // next step write prompts for part of the script and call the step complete.
  const beatsComplete = beatsStepState.status === "done";
  // Prompts already written means the user is past the review gate — that's
  // what keeps every existing project, and any resumed fill, unlocked without
  // needing a stored flag or a backfill.
  const beatsGateOpen = !PROMPTS_THREE_STEP || promptedBeats > 0 || beatsConfirmed;
  // What steps 2 and 3 actually require: the whole script split, and the user
  // done reviewing it.
  const promptStepsUnlocked = beatsComplete && beatsGateOpen;
  // Merging is confined to the window between a finished split and the first
  // prompt. Earlier renumbers rows the running walk is about to write to;
  // once a single prompt exists, a merge leaves the survivor holding text
  // written for its old, shorter segment, and fixing that means paying to
  // rewrite it. Written flag-independently: with the combined pass, prompts
  // land with the beats, so the same rule closes the window there too.
  const canMergeBeats = beatsComplete && promptedBeats === 0 && !beatsConfirmed;
  // Shown on hover when the controls are greyed out — a disabled button with no
  // explanation just reads as broken.
  const mergeHint = canMergeBeats
    ? null
    : !beatsComplete
      ? "Available once the whole script is split into beats"
      : promptedBeats > 0
        ? "Image prompts are already written for these beats"
        : "You continued past the merge step";
  const beatsPendingLabel: ReactNode = beatsResumable && beats.length > 0
    ? <span>
        <span style={{ color: "oklch(0.6 0.15 145)" }}>{`${beats.length} beat${beats.length === 1 ? "" : "s"} so far`}</span>
        <span style={{ color: "oklch(0.65 0.15 75)" }}>, the split did not finish</span>
      </span>
    : undefined;

  const baseImage: StepState =
    imageStep.status !== "idle" ? imageStep :
    imageStoppedByUser ? IDLE :
    imageRemoteRunning ? {
      status: "running",
      message: promptsStopRequested
        ? `Finishing the current section… (${imageWritten} ready so far)`
        : imageTotal > 0
          ? `Generating — ${imageWritten} of ${fillMode ? "" : "~"}${imageTotal} beats generated`
          : hasImageBeats
            ? `Generating — ${imageWritten} beats so far, still generating`
            : "Generating in the background",
      progress: imageProgress,
    } :
    imageStepCompleteOnServer ? { status: "done", message: "" } :
    persistedImageError ? { status: "error", message: "", error: persistedImageError } : IDLE;

  // Rewrite the running message to combine the live persisted beat
  // count with the current chunk's section progress and, when
  // available, the per-beat tally Claude is streaming for the chunk
  // in flight. streamStep emits a generic "Section N of M" message;
  // the page knows beats.length (persisted), section indices, and the
  // live in-chunk beat count, and composes the richer line:
  //   "X ready, section N/M (Y beats in this section)"
  // Only rewrite for the streamStep case — the Generating-after-refresh
  // branch already has its own beat-count-aware message and doesn't
  // have real chunk indices or a live tally to point at.
  const effectiveImage: StepState =
    baseImage.status === "running" && baseImage.progress && baseImage.message.startsWith("Section ")
      ? {
          ...baseImage,
          message: typeof baseImage.liveBeatsInChunk === "number" && baseImage.liveBeatsInChunk > 0
            ? `${imageWritten} ready, section ${baseImage.progress.current}/${baseImage.progress.total} (${baseImage.liveBeatsInChunk} beats in this section)`
            : `${imageWritten} ready, section ${baseImage.progress.current} in progress (${baseImage.progress.current}/${baseImage.progress.total})`,
        }
      : baseImage;

  // Mirror of effectiveImage's derivation. videoRemoteRunning fires
  // when the server has a video run active (run_id + step="videos")
  // and local state is idle — i.e. the user refreshed mid-run. We
  // intentionally don't synthesize a beats-based progress here
  // because video chunks are small (5 beats each) and the route's
  // first progress event lands within a few seconds; the bar
  // backfills naturally.
  const effectiveVideo: StepState =
    videoStep.status !== "idle" ? videoStep :
    videoStoppedByUser ? IDLE :
    videoRemoteRunning ? {
      status: "running",
      message: promptsStopRequested
        ? `Finishing the current section… (${videoBeats.length} ready so far)`
        : hasVideoBeats
          ? `Generating — ${videoBeats.length} motion prompts so far`
          : "Generating motion prompts in the background…",
      progress: beats.length > 0 ? { current: videoBeats.length, total: beats.length } : undefined,
    } :
    videoStepCompleteOnServer ? { status: "done", message: "" } :
    persistedVideoError ? { status: "error", message: "", error: persistedVideoError } : IDLE;

  async function runImageStep() {
    if (!project?.script || !project?.visual_profile) {
      toast.error("Script and visual analysis required first");
      return;
    }
    // Three-step flow: this card writes prompts onto beats that card 1
    // already produced, so it has nothing to do until they exist. Re-read
    // rather than trusting the render's closure — they may have been cleared
    // since.
    if (PROMPTS_THREE_STEP) {
      const fresh = await mutate();
      if (((fresh?.beats ?? []) as Beat[]).length === 0) {
        toast.error("Split the script into beats first.");
        return;
      }
    }
    // User picked Resume (or Generate). Clear the "stopped" sticky so
    // the derived state reflects the new run rather than the prior
    // user-initiated stop. Also clear the stop-grace snapshot so the
    // "Finishing the current section…" spinner doesn't reappear from
    // an earlier Stop.
    setImageStoppedByUser(false);
    setImageStopState(null);
    setImageStep({ status: "running", message: "Starting..." });
    imageAbortRef.current = new AbortController();
    try {
      const doneReceived = await streamStep("/api/workflow/prompts", {
        // "fill" writes prompts onto the existing beats; "images" is the
        // combined pass that segments and prompts in one call.
        step: PROMPTS_THREE_STEP ? "fill" : "images",
        projectId,
        script: project.script,
        visualProfile: project.visual_profile,
        // Send the currently-active tab so an in-session switch is
        // honoured even before the PATCH that persists it settles.
        promptStyle,
      }, setImageStep, imageAbortRef.current.signal);

      // The SSE channel is unreliable — Vercel edge / intermediate
      // proxies routinely truncate long-lived streams, and a single
      // chunk's progress event can arrive seconds before the route's
      // remaining workers actually settle. Treating stream end == work
      // end caused the card to flip to "done" mid-run after the first
      // chunk persisted (status: "running" → status: "done") because
      // the route's success-path `current_state: 14` write hadn't
      // landed yet but the SSE stream had already closed.
      //
      // Instead: poll the project row until we have an authoritative
      // signal. The route only writes `current_state >= 14` after the
      // full worker pool settles successfully; on failure it clears
      // `prompts_active_run_id` (via the try/finally in the route).
      // Either signal terminates the loop. Until then, keep the card
      // in "running" with live beat counts and a Stop button.
      const POLL_MS = 3000;
      // Stall watchdog: prompts_active_run_id carries no server heartbeat
      // (migration 030 is a bare UUID), so a run that dies without its
      // finally — function timeout at maxDuration=800, crash, or a mid-run
      // redeploy — leaves the flag set forever and this loop would poll
      // indefinitely, pinning the bar at the ~95% ceiling. If the persisted
      // beat count stops advancing for STALL_MS while the server still
      // claims the run active, treat it as a dead run and surface a
      // resumable error.
      //
      // Threshold must sit ABOVE the server's worst-case gap between beat
      // persists on a *healthy* run, or we'd false-trip a slow-but-live
      // chunk. That worst case is a KIE stream idle-abort (120s, route.ts)
      // followed by a fresh full-length stream (these dense chunks run
      // ~5 min), i.e. ~7 min before the retried chunk lands. 450s clears
      // it. Only reached when the SSE channel already dropped (else the
      // client stays in streamStep, kept warm by the route's heartbeat).
      const STALL_MS = 450_000;
      // What "advancing" means differs by flow. The combined pass creates
      // beats, so the beat count grows; the fill pass writes onto beats that
      // all exist from the start, so the count NEVER changes and the watchdog
      // would fire mid-run on every project. Count written prompts there.
      const writtenCount = (rows: Beat[]) =>
        PROMPTS_THREE_STEP ? rows.filter((b) => !!b.imagePrompt).length : rows.length;
      let fresh = await mutate();
      let maxBeatsSeen = writtenCount((fresh?.beats ?? []) as Beat[]);
      let lastAdvanceAt = Date.now();
      while (true) {
        if (imageAbortRef.current?.signal.aborted) {
          setImageStep(IDLE);
          await mutate();
          return;
        }
        const freshBeats = (fresh?.beats ?? []) as Beat[];
        const written = writtenCount(freshBeats);
        if (written > maxBeatsSeen) {
          maxBeatsSeen = written;
          lastAdvanceAt = Date.now();
        }
        const completedOnServer = (fresh?.current_state ?? 0) >= 14;
        const beatsReady = freshBeats.length > 0 && freshBeats.every((b) => !!b.imagePrompt);
        const serverStillActive = !!fresh?.prompts_active_run_id;

        if (completedOnServer && beatsReady) {
          setImageStep({ status: "done", message: "" });
          toast.success("Image prompts generated");
          if (hasVideoBeats) setVideoStep(IDLE);
          return;
        }
        // current_state >= 14 with missing/zero beats is only a real
        // inconsistency once the server has RELEASED the run. While a
        // run is still claimed, this is the transient regen window: a
        // prior success left current_state at 14, clear_image_prompts
        // wiped the beats, and the new run's walkback-to-13 hasn't
        // landed yet. Hard-failing here surfaced a scary error on a
        // perfectly healthy run — keep polling instead.
        if (completedOnServer && !serverStillActive) {
          throw new Error("Some beats are missing prompts. Try again. Existing beats are kept.");
        }
        if (!serverStillActive) {
          // Route released its run id without writing current_state=14
          // → it threw and the finally cleared the flag. Surface as
          // error so the user can retry.
          throw new Error(doneReceived
            ? "The step did not finish. Try again. Existing beats are kept."
            : "Generation stopped before finishing. Try again. Saved beats are kept.");
        }
        if (Date.now() - lastAdvanceAt > STALL_MS) {
          // Server still advertises an active run but no new beats have
          // landed for STALL_MS — the run almost certainly died without
          // clearing its flag (timeout/crash/redeploy). Stop polling and
          // let the user resume; the route's chunk-walk picks up where
          // this left off, preserving every beat already saved.
          throw new Error("Generation stalled. Click Generate to resume. Saved beats are kept.");
        }

        // Server is still working — keep the card live. In the three-step
        // flow the total is exact (the beats are all there), so no "~".
        const pollTotal = PROMPTS_THREE_STEP ? freshBeats.length : estimatedTotalBeats;
        setImageStep({
          status: "running",
          message: pollTotal > 0
            ? `Generating — ${written} of ${PROMPTS_THREE_STEP ? "" : "~"}${pollTotal} beats so far`
            : `Generating — ${written} beats so far`,
          progress: pollTotal > 0
            ? { current: Math.min(written, pollTotal - 1), total: pollTotal }
            : undefined,
        });

        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, POLL_MS);
          imageAbortRef.current?.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
        });
        fresh = await mutate();
      }
    } catch (err) {
      // User-initiated Stop comes through as an AbortError — don't
      // surface that as a failure. Whatever was persisted before the
      // abort is still in the DB.
      if (err instanceof Error && err.name === "AbortError") {
        setImageStep(IDLE);
        await mutate();
      } else {
        const msg = err instanceof Error ? err.message : "Failed";
        setImageStep({ status: "error", message: "", error: friendlyError(msg) });
      }
    } finally {
      imageAbortRef.current = null;
    }
  }

  // Intercept onGenerate when the step is already complete: a click on
  // "Regenerate" is destructive (it wipes finished beats) and must pass
  // through a confirmation modal first. Idle/error states fire the
  // normal run path — the route's chunk-resume logic keeps partial
  // beats and only fills the gap.
  function requestRunImageStep() {
    if (effectiveImage.status === "done") { setRegenTarget("image"); return; }
    runImageStep();
  }
  function requestRunVideoStep() {
    if (effectiveVideo.status === "done") { setRegenTarget("video"); return; }
    runVideoStep();
  }

  async function confirmRegen() {
    if (!regenTarget) return;
    setRegenerating(true);
    try {
      // In the three-step flow, clear the prompt text and keep the rows: the
      // beats belong to card 1, and deleting them here would take the
      // segmentation — and the user's merges — with them.
      const body = regenTarget === "image"
        ? (fillMode ? { clear_image_prompt_text: true } : { clear_image_prompts: true })
        : { clear_video_prompts: true };
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to clear before regenerating");
      }
      const target = regenTarget;
      // Image clear also wipes video prompts (they live on the same
      // rows), mirroring confirmClear above.
      if (target === "image") {
        setImageStep(IDLE);
        setVideoStep(IDLE);
      } else {
        setVideoStep(IDLE);
      }
      await mutate();
      setRegenTarget(null);
      setRegenerating(false);
      if (target === "image") {
        await runImageStep();
      } else {
        await runVideoStep();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to regenerate");
      setRegenerating(false);
    }
  }

  async function confirmClear() {
    if (!clearTarget) return;
    setClearing(true);
    try {
      const body = clearTarget === "image"
        ? (fillMode ? { clear_image_prompt_text: true } : { clear_image_prompts: true })
        : { clear_video_prompts: true };
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to clear");
      }
      if (clearTarget === "image") {
        setImageStep(IDLE);
        setVideoStep(IDLE); // video prompts live on the same rows
        setImageStoppedByUser(false);
        setVideoStoppedByUser(false);
      } else {
        setVideoStep(IDLE);
        setVideoStoppedByUser(false);
      }
      await mutate();
      toast.success(clearTarget === "image" ? "Cleared image prompts" : "Cleared video prompts");
      setClearTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to clear");
    } finally {
      setClearing(false);
    }
  }

  async function confirmMerge() {
    if (!mergeTarget) return;
    setMerging(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/beats/merge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...mergeTarget, segment: mergeDraft }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; keptBeatNumber?: number; remainingBeats?: number };
      if (!res.ok) throw new Error(data.error ?? "Merge failed");
      await mutate();
      toast.success(`Merged into beat ${data.keptBeatNumber}. Reread its prompts.`);
      setMergeTarget(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Merge failed");
    } finally {
      setMerging(false);
    }
  }

  // Previewed with the same planner the route runs, so the count the user
  // approves is the count that happens. Auto can't be previewed exactly — the
  // side is Claude's call server-side — so it previews as "up" for the count
  // (the set of stubs is the same either way) and the dialog says so.
  const bulkPlanBeats = beats.map((b) => ({ beatNumber: b.beatNumber, scriptSegment: b.scriptSegment ?? "" }));
  const bulkPlan = planBulkMerge(bulkPlanBeats, bulkMinWords, bulkDirection === "auto" ? "up" : bulkDirection);
  const bulkStubs = bulkDirection === "auto" ? findStubs(bulkPlanBeats, bulkMinWords) : [];

  async function runBulkMerge() {
    setBulkRunning(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/beats/merge/bulk`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ minWords: bulkMinWords, direction: bulkDirection }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; merged?: number; remainingBeats?: number };
      if (!res.ok) throw new Error(data.error ?? "Bulk merge failed");
      await mutate();
      toast.success(`Merged ${data.merged} beat${data.merged === 1 ? "" : "s"} away. ${data.remainingBeats} left.`);
      setBulkOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Bulk merge failed");
    } finally {
      setBulkRunning(false);
    }
  }

  // Card 1: segmentation only. Deliberately has no Regenerate — re-splitting
  // deletes the beat rows and takes the paid prompts, renders and voiceovers
  // with them — so this only ever runs from a project with no beats.
  async function runBeatsStep() {
    if (!project?.script) {
      toast.error("A script is required first");
      return;
    }
    setBeatsStoppedByUser(false);
    setBeatsStep({ status: "running", message: "Starting..." });
    beatsAbortRef.current = new AbortController();
    try {
      await streamStep("/api/workflow/prompts", {
        step: "beats",
        projectId,
        script: project.script,
        // Style decides beat DENSITY, not just prompt wording, so send the
        // active tab rather than letting the server fall back to the row.
        promptStyle,
      }, setBeatsStep, beatsAbortRef.current.signal);

      // Same reasoning as runImageStep: the SSE channel dies on long runs, so
      // the DB decides. Unlike the image step there is no current_state mark
      // to wait for — generateBeats deliberately leaves the project at 13
      // because prompts still have to be written — so the authoritative
      // signal is the run being released with the script's hash recorded,
      // which generateBeats writes only on its success path.
      const POLL_MS = 3000;
      const STALL_MS = 450_000;
      let fresh = await mutate();
      let maxBeatsSeen = ((fresh?.beats ?? []) as Beat[]).length;
      let lastAdvanceAt = Date.now();
      while (true) {
        if (beatsAbortRef.current?.signal.aborted) {
          setBeatsStep(IDLE);
          await mutate();
          return;
        }
        const freshBeats = (fresh?.beats ?? []) as Beat[];
        if (freshBeats.length > maxBeatsSeen) {
          maxBeatsSeen = freshBeats.length;
          lastAdvanceAt = Date.now();
        }
        const serverStillActive = !!fresh?.prompts_active_run_id;

        if (!serverStillActive) {
          // Hash written + beats present = the chunk walk finished. Beats with
          // no hash means it died partway; the next run resumes from them.
          const hashRecorded = !!fresh?.prompts_script_hash
            && (!currentScriptHash || fresh.prompts_script_hash === currentScriptHash);
          if (freshBeats.length > 0 && hashRecorded) {
            setBeatsStep({ status: "done", message: "" });
            toast.success(`Script split into ${freshBeats.length} beats`);
            return;
          }
          throw new Error(freshBeats.length > 0
            ? "Splitting stopped before finishing. Click Generate to continue — saved beats are kept."
            : "Splitting did not finish. Try again.");
        }
        if (Date.now() - lastAdvanceAt > STALL_MS) {
          throw new Error("Splitting stalled. Click Generate to resume. Saved beats are kept.");
        }

        setBeatsStep({
          status: "running",
          message: estimatedTotalBeats > 0
            ? `Splitting — ${freshBeats.length} of ~${estimatedTotalBeats} beats so far`
            : `Splitting — ${freshBeats.length} beats so far`,
          progress: estimatedTotalBeats > 0
            ? { current: Math.min(freshBeats.length, estimatedTotalBeats - 1), total: estimatedTotalBeats }
            : undefined,
        });

        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, POLL_MS);
          beatsAbortRef.current?.signal.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
        });
        fresh = await mutate();
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setBeatsStep(IDLE);
        await mutate();
      } else {
        setBeatsStep({ status: "error", message: "", error: friendlyError(err instanceof Error ? err.message : "Failed") });
      }
    } finally {
      beatsAbortRef.current = null;
    }
  }

  async function runVideoStep() {
    // Re-check server state — image beats may have been cleared since
    // the page rendered. Pull fresh data and read the latest from the
    // response rather than relying on the SWR-cached `beats` closure.
    const fresh = await mutate();
    const freshBeats = (fresh?.beats ?? []) as Beat[];
    // Beats existing isn't enough — each motion prompt is written from its
    // beat's image prompt, so re-check for those, not just for rows.
    if (freshBeats.filter((b) => !!b.imagePrompt).length === 0) {
      toast.error("Image prompts are missing. Generate them first.");
      setVideoStep(IDLE);
      return;
    }
    setVideoStoppedByUser(false);
    // Mirrors runImageStep: clear the stop-grace snapshot so the
    // "Finishing the current section…" spinner doesn't carry over.
    setVideoStopState(null);
    setVideoStep({ status: "running", message: "Starting..." });
    videoAbortRef.current = new AbortController();
    try {
      const doneReceived = await streamStep("/api/workflow/prompts", {
        step: "videos",
        projectId,
      }, setVideoStep, videoAbortRef.current.signal);

      const updated = await mutate();
      const updatedBeats = (updated?.beats ?? []) as Beat[];
      const completedOnServer =
        updatedBeats.length > 0 && updatedBeats.every((b) => !!b.videoPrompt);

      if (doneReceived || completedOnServer) {
        setVideoStep({ status: "done", message: "" });
        toast.success("Video prompts generated");
      } else {
        throw new Error("Generation timed out before finishing. Try again. Saved prompts are kept.");
      }
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        setVideoStep(IDLE);
        await mutate();
      } else {
        const msg = err instanceof Error ? err.message : "Failed";
        setVideoStep({ status: "error", message: "", error: friendlyError(msg) });
      }
    } finally {
      videoAbortRef.current = null;
    }
  }

  // Stop handler shared by both StepCards. Two-sided cancellation
  // matching the script step:
  //   1) Set prompts_stop_requested = true so the server's next
  //      assertPromptsRunActive throws and exits cleanly. Leave
  //      prompts_active_run_id alone — the server clears it (and
  //      the stop flag) in releasePromptsRunIfOwned once the
  //      in-flight chunk's worker has actually exited. Keeping
  //      run_id non-null means the prompts page still detects
  //      videoRemoteRunning / imageRemoteRunning on refresh and
  //      keeps showing the "Generating — N motion prompts so far"
  //      (or, when stop_requested is set, "Finishing the current
  //      section…") indicator instead of falling back to a bare
  //      partial state with no spinner.
  //   2) Abort the local SSE fetch (if any) so the UI snaps to "stopped"
  //      instantly instead of waiting up to a chunk-cycle for the server
  //      to close the stream.
  // Beats already persisted to the DB are kept.
  async function handleStopPrompts() {
    // Capture which step the user was actually stopping. A non-null
    // abort ref means runImageStep/runVideoStep is still in flight on
    // this client — that's what they Stop button is acting on.
    const wasBeatsActive = !!beatsAbortRef.current;
    const wasImageActive = !!imageAbortRef.current;
    const wasVideoActive = !!videoAbortRef.current;
    if (beatsAbortRef.current) {
      try { beatsAbortRef.current.abort(); } catch { /* ignore */ }
      beatsAbortRef.current = null;
    }
    if (imageAbortRef.current) {
      try { imageAbortRef.current.abort(); } catch { /* ignore */ }
      imageAbortRef.current = null;
    }
    if (videoAbortRef.current) {
      try { videoAbortRef.current.abort(); } catch { /* ignore */ }
      videoAbortRef.current = null;
    }
    // Force the step the user actively stopped to IDLE, regardless of
    // whether a racing completion check inside the polling loop just
    // flipped it to "done". User-initiated Stop wins.
    // No stopped-sticky for beats: the beats that landed are simply there and
    // the same Generate resumes from them.
    if (wasBeatsActive) {
      setBeatsStep(IDLE);
      setBeatsStoppedByUser(true);
    }
    if (wasImageActive) {
      setImageStep(IDLE);
      setImageStoppedByUser(true);
      // Snapshot the beat count NOW so the "in-flight section still
      // finishing" spinner can hide itself the moment the in-flight
      // chunk's beats land (current beats.length will exceed snapshot).
      setImageStopState({ stoppedAt: Date.now(), snapshot: beats.length });
    }
    if (wasVideoActive) {
      setVideoStep(IDLE);
      setVideoStoppedByUser(true);
      setVideoStopState({ stoppedAt: Date.now(), snapshot: videoBeats.length });
    }
    try {
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompts_stop_requested: true }),
      });
      await mutate();
    } catch {
      // Best-effort — the local abort is the more important signal.
    }
  }

  // Escape hatch for a run the server never released — a function timeout,
  // crash or redeploy leaves prompts_active_run_id set with nobody working,
  // and the cards derive "running" from it, so the step freezes at
  // "Finishing the current section…" with Stop already spent and Merge beats
  // disabled. Clearing the three flags is safe even if a worker IS alive: the
  // run-id mismatch is the same signal Stop uses, so it exits at its next
  // check. Beats already written stay.
  async function resetStuckRun() {
    try {
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompts_active_run_id: null,
          prompts_active_step: null,
          prompts_stop_requested: false,
        }),
      });
      setBeatsStep(IDLE);
      setImageStep(IDLE);
      setVideoStep(IDLE);
      await mutate();
      toast.success("Run cleared — saved beats are kept");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not clear the run");
    }
  }

  // Shown only once the user has already asked to stop and the server still
  // claims the run — the exact state that can hang indefinitely.
  const resetRunButton = remoteRunInProgress && promptsStopRequested ? (
    <button
      onClick={resetStuckRun}
      title="The server still reports this run as active. Clear it and keep the beats already saved."
      className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80"
      style={{ background: "transparent", color: "oklch(0.7 0.22 25)", border: "1px solid oklch(0.6 0.22 25 / 0.4)" }}
    >
      Force stop
    </button>
  ) : null;

  // Beats first: it is the step that comes first and the only one that shows
  // the narration. The two prompt tabs count prompts written, not beats, so a
  // half-finished prompts run reads honestly.
  const tabs: { id: Tab; label: string; shortLabel: string; count: number }[] = [
    { id: "beats", label: "Beats", shortLabel: "Beats", count: beats.length },
    { id: "image", label: "Image Prompts", shortLabel: "Image", count: promptedBeats },
    { id: "video", label: "Video Prompts", shortLabel: "Video", count: videoBeats.length },
  ];

  const anyRunning =
    beatsStep.status === "running" ||
    imageStep.status === "running" ||
    videoStep.status === "running";

  // Rendered in two places on purpose: on the Beats step, where the decision
  // belongs, and above the beat list, where the user is actually looking at
  // the beats. Defined once so the two copies cannot drift apart. `shape`
  // is the only difference — the step card's buttons are rounded-lg, the
  // toolbar's are rounded-xl.
  const mergeBeatsButton = (shape: string) =>
    beats.length > 1 && !MERGE_BEATS_HIDDEN ? (
      <button
        onClick={() => setBulkOpen(true)}
        disabled={anyRunning || remoteRunInProgress || !canMergeBeats}
        title={mergeHint ?? "Merge beats that are too short to hold a shot"}
        className={`flex items-center gap-1.5 px-3 py-1.5 ${shape} text-xs font-medium transition-all hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:opacity-40`}
        style={{ background: "var(--bg-progress)", color: "var(--c-60)", border: "1px solid var(--bd-card)" }}
      >
        Merge beats
        <span className="text-[9px] font-bold uppercase tracking-wide" style={{ color: "oklch(0.65 0.24 25)" }}>
          New
        </span>
      </button>
    ) : null;

  // Offer to move this step off KIE and onto the client's own Anthropic key.
  //
  // Currently disabled. The offer was written when every recorded prompts
  // failure was a KIE 500 on /claude, so rerouting to Anthropic genuinely
  // sidestepped the cause. That is no longer the shape of a failure: the prompt
  // steps can run on GPT or Gemini (Config → Anthropic → Per step), where a
  // failure has nothing to do with Anthropic and the offer would move the user
  // onto a different model family — spending their Anthropic key to "fix"
  // something Anthropic wasn't involved in.
  //
  // The reroute machinery below (confirmReroute, the key dialog) is left intact
  // so this is one line to bring back once it can tell which provider the step
  // is actually on.
  function anthropicOffer(_step: "beats" | "image" | "video"): ReactNode {
    return null;
  }

  // Turn direct routing on (adding the key first if this is the client's first
  // time) and immediately retry the step that failed. Saving without retrying
  // would leave the user looking at the same error, unsure it took.
  async function confirmReroute() {
    if (!rerouteFor) return;
    const needsKey = !anthropicRouting?.hasKey;
    const key = anthropicKeyDraft.trim();
    if (needsKey && !key) {
      toast.error("Paste your Anthropic API key first.");
      return;
    }
    setSwitchingRoute(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(needsKey ? { anthropic_api_key: key } : {}),
          anthropic_direct_enabled: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save the key");
      // Re-read rather than assuming: the server decides whether the step is
      // eligible, and the offer must disappear only if it really switched.
      refreshAnthropicRouting();
      const step = rerouteFor;
      setRerouteFor(null);
      setAnthropicKeyDraft("");
      toast.success("Switched to your Anthropic key — retrying");
      if (step === "beats") await runBeatsStep();
      else if (step === "image") await runImageStep();
      else await runVideoStep();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not switch routing");
    } finally {
      setSwitchingRoute(false);
    }
  }

  // Unlocks steps 2 and 3. Sits to the right of Merge beats so the two read as
  // "merge first, or go straight on". Disappears once the gate is open.
  const continueButton = beatsComplete && !beatsGateOpen ? (
    <button
      onClick={() => setContinueOpen(true)}
      disabled={anyRunning || remoteRunInProgress}
      title="Move on to image prompts. Merging after this point means paying to rewrite the merged beat's prompt."
      className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-40"
      style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
    >
      Continue
    </button>
  ) : null;

  // Hash the current script in the browser so we can compare it against
  // the hash stored when these beats were generated. If they differ, the
  // saved beats describe an older version of the script and the user
  // should be warned before they continue downstream into images/videos.
  // Mirrors the voiceover-stale detection on the generate page.
  const [currentScriptHash, setCurrentScriptHash] = useState<string | null>(null);
  useEffect(() => {
    const script = project?.script as string | undefined;
    if (!script) { setCurrentScriptHash(null); return; }
    let cancelled = false;
    (async () => {
      const buf = new TextEncoder().encode(script);
      const digest = await crypto.subtle.digest("SHA-256", buf);
      const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
      if (!cancelled) setCurrentScriptHash(hex);
    })();
    return () => { cancelled = true; };
  }, [project?.script]);
  const beatsStale = hasImageBeats
    && !anyRunning
    && !remoteRunInProgress
    && !!project?.prompts_script_hash
    && !!currentScriptHash
    && project.prompts_script_hash !== currentScriptHash;

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "var(--bg-page-2)" }}>
      <WizardNav projectId={projectId} currentState={9} highestState={project?.current_state} channelName={project?.channel_name} />

      <main ref={scrollContainerRef} className="flex-1 overflow-y-auto pt-[105px] md:pt-0 lg:px-[15px]">
        {/* Header */}
        <div className="shrink-0 px-5 sm:px-8 py-4 sm:py-5"
          style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}>
          <div>
            <h1 className="font-bold text-base sm:text-lg">Prompts</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              Image and video prompts generated from your script beats
            </p>
            <div className="mt-3 flex items-center gap-2 flex-wrap min-w-0 w-full">
              <StepCostCard projectId={projectId} column="prompts" />
              <StepBalanceCard />
              <CostTipsModal />
            </div>
          </div>
        </div>

        <div className="mx-5">
        {/* Step cards. md:pr-44 keeps the right-edge action buttons
            (Clear/Resume/Regenerate) clear of the fixed top-right
            Back + ThemeToggle + Profile cluster in WizardNav. md:pt-16
            drops the first card below that cluster's vertical band so
            they don't visually collide near the top edge. */}
        <div className="mb-4">
        <div className="rounded-2xl px-5 sm:px-8 py-4 sm:py-5 space-y-3"
          style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
          {beatsStale && (
            <div className="rounded-xl px-3 py-2.5 flex items-start gap-2 text-xs"
              style={{ background: "oklch(0.72 0.16 70 / 0.12)", border: "1px solid oklch(0.72 0.16 70 / 0.35)", color: "var(--accent-amber-text)" }}>
              <span aria-hidden>⚠</span>
              <span>
                Script was edited after these beats were generated. The image prompts below no longer match your current script — click <strong>Regenerate</strong> to update them.
              </span>
            </div>
          )}
          {/* Style tabs — General is the default, Cinematic layers
              filmic cues (letterbox, grain, dramatic lighting) into
              the prompt at generation time. Switching after beats
              exist requires a regenerate to actually take effect;
              the note under the tabs makes that explicit. */}
          <div className="rounded-xl p-1 flex gap-1 self-start w-fit"
            style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-card)" }}>
            {([
              { id: "general" as const, label: "General" },
              { id: "cinematic" as const, label: "Cinematic" },
            ]).map((t) => {
              const active = promptStyle === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setPromptStyle(t.id)}
                  disabled={anyRunning || remoteRunInProgress}
                  className="px-3 py-1 rounded-lg text-xs font-medium transition-all disabled:opacity-40"
                  style={active ? {
                    background: "oklch(0.72 0.25 285 / 0.15)",
                    border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                    color: "var(--accent-purple-text)",
                  } : {
                    background: "transparent",
                    border: "1px solid transparent",
                    color: "var(--c-55)",
                  }}
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          <PrefixPanel projectId={projectId} project={project} mutate={mutate} defText={accountConsistencyText} onAccountSaved={refreshAccountConsistency} />
          {hasImageBeats
            && !anyRunning
            && !remoteRunInProgress
            && (project?.prompt_style ?? "general") !== promptStyle && (
            <div className="rounded-xl px-3 py-2.5 flex items-start gap-2 text-xs"
              style={{ background: "oklch(0.72 0.16 70 / 0.12)", border: "1px solid oklch(0.72 0.16 70 / 0.35)", color: "var(--accent-amber-text)" }}>
              <span aria-hidden>⚠</span>
              <span>
                Style changed to <strong>{promptStyle === "cinematic" ? "Cinematic" : "General"}</strong>. Existing prompts still use the previous style — click <strong>Regenerate</strong> to apply.
              </span>
            </div>
          )}
          {/* Step 1 — the beats themselves. Until PROMPTS_THREE_STEP is on,
              beats are still a by-product of the Image Prompts call, so this
              card reports state and deliberately has no button of its own:
              it is derived from data every existing project already has, so
              finished projects read as complete with no backfill. */}
          <StepCard
            num={1}
            title="Beats"
            description="Your script split into beats. Merge any that are too short before prompts are written for them"
            state={beatsStepState}
            doneLabel={beats.length > 0 ? `${beats.length} beat${beats.length === 1 ? "" : "s"}` : undefined}
            // Generate while there is nothing, Merge once there is. Notably no
            // Regenerate: re-splitting deletes the beat rows, taking the paid
            // image prompts, renders and voiceovers with them.
            //
            // The Generate is also gated on the split being live — until then
            // there is no beats-only run, so the only thing it could fire is
            // the combined Image Prompts call, which would create prompts in
            // the same breath and destroy the merge window this step exists
            // to open.
            hideAction={!PROMPTS_THREE_STEP || (beats.length > 0 && !beatsResumable)}
            actionLabel={beats.length > 0 ? "Resume" : null}
            pendingLabel={beatsPendingLabel}
            errorAction={anthropicOffer("beats")}
            extraAction={<>{beatsRemoteRunning && resetRunButton}{mergeBeatsButton("rounded-lg")}{continueButton}</>}
            windingDown={beatsRemoteRunning && promptsStopRequested}
            onStop={handleStopPrompts}
            onGenerate={runBeatsStep}
          />
          <StepCard
            num={2}
            title="Image Prompts"
            description="One AI image prompt per script beat, matched to your channel's visual style"
            state={effectiveImage}
            extraAction={imageRemoteRunning ? resetRunButton : null}
            windingDown={imageRemoteRunning && promptsStopRequested}
            // In the three-step flow this card writes onto the beats card 1
            // made, so it stays locked until the script is fully split AND the
            // user has clicked Continue there.
            disabled={PROMPTS_THREE_STEP && !promptStepsUnlocked}
            doneLabel={beats.length > 0 ? `${beats.length} beats ready` : undefined}
            pendingLabel={imagePendingLabel}
            errorAction={anthropicOffer("image")}
            actionLabel={imageActionLabel}
            onClear={hasImageBeats ? () => setClearTarget("image") : null}
            onStop={handleStopPrompts}
            onGenerate={requestRunImageStep}
          />
          <StepCard
            num={3}
            title="Video Prompts"
            description="Camera movement and motion instructions layered on top of each image beat"
            state={effectiveVideo}
            extraAction={videoRemoteRunning ? resetRunButton : null}
            windingDown={videoRemoteRunning && promptsStopRequested}
            doneLabel={videoBeats.length > 0 ? `${videoBeats.length} beats ready` : undefined}
            pendingLabel={videoPendingLabel}
            errorAction={anthropicOffer("video")}
            actionLabel={videoActionLabel}
            onClear={hasVideoBeats ? () => setClearTarget("video") : null}
            onStop={handleStopPrompts}
            // Also needs image prompts to exist: a video prompt is written
            // from its beat's image prompt, so there is nothing to derive from
            // until at least one is there.
            disabled={!promptStepsUnlocked || promptedBeats === 0}
            optional
            onGenerate={requestRunVideoStep}
          />
        </div>
        </div>

        {/* Tabs + content */}
        {hasImageBeats && (
          <div className="pb-24">
          <div className="rounded-2xl overflow-hidden"
            style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
            <div className="mx-5 sm:mx-8 mt-4 flex items-center justify-between gap-3 flex-wrap">
            {/* w-fit sized the strip to its content with nothing to stop it
                exceeding the viewport, so on a phone the last tab's count was
                cut off at the screen edge. max-w-full plus scrolling means it
                can never clip whatever the counts grow to (a 788-beat project
                is three digits per badge), and the short labels below keep it
                inside a 360px screen so the scroll is a safety net rather than
                something the user has to use. */}
            <div className="rounded-xl p-1 flex gap-1 w-fit max-w-full overflow-x-auto"
              style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-card)", scrollbarWidth: "none" }}>
              {tabs.map((tab) => {
                const active = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className="px-2.5 sm:px-3 py-1 rounded-lg text-xs font-medium transition-all flex items-center gap-1.5 shrink-0 whitespace-nowrap"
                    style={active ? {
                      background: "oklch(0.72 0.25 285 / 0.15)",
                      border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                      color: "var(--accent-purple-text)",
                    } : {
                      background: "transparent",
                      border: "1px solid transparent",
                      color: "var(--c-55)",
                    }}
                  >
                    {/* "Image Prompts"/"Video Prompts" are what make the strip
                        overflow a phone. The tab sits directly above the list
                        it filters, so the qualifier is redundant there. */}
                    <span className="sm:hidden">{tab.shortLabel}</span>
                    <span className="hidden sm:inline">{tab.label}</span>
                    {tab.count > 0 && (
                      <span className="px-1.5 py-0.5 rounded-full text-[10px] tabular-nums"
                        style={{
                          background: active ? "oklch(0.72 0.25 285 / 0.2)" : "var(--bg-panel)",
                          color: active ? "var(--accent-purple-text)" : "var(--c-45)",
                        }}>
                        {tab.count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
            <div className="ml-auto">{mergeBeatsButton("rounded-xl")}</div>
            {/* Export dropdown. The backdrop sits behind the menu so a click
                anywhere else dismisses it without a document listener. */}
            <div className="relative">
              <button
                onClick={() => setExportMenuOpen((v) => !v)}
                disabled={exportingDocx}
                title="Download the beat prompts as PDF or Word"
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80 disabled:opacity-50"
                style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-card)", color: "var(--c-70)" }}
              >
                <Download size={13} />
                {exportingDocx ? "Exporting…" : "Export"}
                <span className="text-[9px] font-bold uppercase tracking-wide" style={{ color: "oklch(0.65 0.24 25)" }}>
                  New
                </span>
                <ChevronDown size={13} />
              </button>
              {exportMenuOpen && !exportingDocx && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setExportMenuOpen(false)} />
                  <div className="absolute right-0 mt-1 z-20 rounded-lg overflow-hidden min-w-[11rem]"
                    style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)", boxShadow: "0 8px 24px oklch(0 0 0 / 0.35)" }}>
                    {/* What to include. Ticking both gives the full set. */}
                    <div className="px-1 py-1">
                      {([
                        { on: exportImage, set: setExportImage, label: "Image prompts" },
                        { on: exportVideo, set: setExportVideo, label: "Video prompts" },
                      ]).map((opt) => (
                        <button
                          key={opt.label}
                          onClick={() => opt.set((v) => !v)}
                          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-xs font-medium transition-colors hover:opacity-80"
                          style={{ color: "var(--c-70)" }}
                        >
                          <span className="w-3.5 h-3.5 rounded flex items-center justify-center shrink-0"
                            style={opt.on
                              ? { background: "oklch(0.72 0.25 285)", border: "1px solid white" }
                              : { background: "transparent", border: "1px solid white" }}>
                            {opt.on && <Check size={10} strokeWidth={3} color="white" />}
                          </span>
                          {opt.label}
                        </button>
                      ))}
                    </div>
                    <div style={{ borderTop: "1px solid var(--bd-card)" }}>
                      {([
                        { format: "pdf" as const, label: "PDF" },
                        { format: "docx" as const, label: "Word" },
                      ]).map((opt) => (
                        <button
                          key={opt.format}
                          onClick={() => exportPrompts(opt.format)}
                          disabled={!exportImage && !exportVideo}
                          title={!exportImage && !exportVideo ? "Tick at least one prompt kind" : undefined}
                          className="w-full text-left px-3 py-2 text-xs font-medium transition-colors hover:opacity-80 disabled:opacity-40 disabled:cursor-not-allowed"
                          style={{ color: "var(--c-70)" }}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
            </div>

            <div className="px-5 sm:px-8 pt-6 pb-6 space-y-3">
              {(activeTab === "beats" || activeTab === "image") && (() => {
                // The image tab lists only beats that actually have a prompt,
                // so a partial run doesn't pad the list with empty cards.
                const rows = activeTab === "beats" ? beats : beats.filter((b) => b.imagePrompt?.trim());
                if (rows.length === 0) {
                  return (
                    <div className="text-center py-12">
                      <p className="text-sm" style={{ color: "var(--c-40)" }}>
                        {activeTab === "beats"
                          ? "Run Beats to split your script."
                          : "Run Image Prompts to write a prompt for each beat."}
                      </p>
                    </div>
                  );
                }
                return rows.map((beat, i) => (
                  <BeatCard
                    key={beat.beatNumber}
                    beat={beat}
                    projectId={projectId}
                    onSaved={mutate}
                    consistencyPreview={consistencyPreview}
                    mode={activeTab === "beats" ? "beats" : "image"}
                    isFirst={i === 0}
                    isLast={i === rows.length - 1}
                    canMerge={canMergeBeats}
                    mergeHint={mergeHint}
                    onMerge={(beatNumber, direction) => {
                      const keep = direction === "up" ? beatNumber - 1 : beatNumber;
                      const a = beats.find((b) => b.beatNumber === keep)?.scriptSegment ?? "";
                      const b = beats.find((x) => x.beatNumber === keep + 1)?.scriptSegment ?? "";
                      setMergeDraft(joinSegments(a, dedupeOverlap(b, a)));
                      setMergeTarget({ beatNumber, direction });
                    }}
                  />
                ));
              })()}
              {activeTab === "video" && (
                videoBeats.length > 0 ? videoBeats.map((beat) => (
                  <div key={beat.beatNumber} className="rounded-xl p-4 space-y-3"
                    style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
                    <div className="flex items-center gap-3">
                      <span className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold shrink-0"
                        style={{ background: "oklch(0.6 0.15 200 / 0.12)", color: "oklch(0.6 0.15 200)" }}>
                        {beat.beatNumber}
                      </span>
                      {/* Prompts only — the narration lives on the Beats tab. */}
                      <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "oklch(0.55 0.12 200)" }}>
                        Video Prompt
                      </p>
                      <CopyButton text={beat.videoPrompt ?? ""} />
                    </div>
                    <EditablePrompt
                      value={beat.videoPrompt ?? ""}
                      field="video"
                      beatNumber={beat.beatNumber}
                      projectId={projectId}
                      onSaved={mutate}
                      accent="oklch(0.55 0.12 200)"
                      textColor="var(--c-70)"
                    />
                  </div>
                )) : (
                  <div className="text-center py-12">
                    <p className="text-sm" style={{ color: "var(--c-40)" }}>
                      Run Step 2 to generate video motion prompts.
                    </p>
                  </div>
                )
              )}
            </div>
          </div>
          </div>
        )}

        {/* Empty state when nothing generated yet */}
        {!hasImageBeats && imageStep.status === "idle" && (
          <div className="flex items-center justify-center py-24">
            <div className="text-center space-y-3">
              <div className="w-12 h-12 rounded-xl mx-auto flex items-center justify-center text-xl"
                style={{ background: "var(--bg-control)", border: "1px solid var(--bd-8)" }}>
                ⬡
              </div>
              <p className="text-sm font-semibold">No prompts yet</p>
              <p className="text-xs" style={{ color: "var(--c-40)" }}>
                Start with Step 1 to generate image prompts for every script beat.
              </p>
            </div>
          </div>
        )}
        </div>

        {/* Jump-to-top / jump-to-bottom — floating purple chevrons, same
            affordance as the voiceover + generate steps. Only when the
            per-beat prompt list is present (otherwise there's nothing long
            to scroll). */}
        {hasImageBeats && (
          <>
            <button
              type="button"
              onClick={() => scrollContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
              title="Jump to the top"
              aria-label="Scroll to top"
              className="fixed top-24 right-5 z-30 w-7 h-7 rounded-md flex items-center justify-center transition-all hover:scale-105 active:scale-95"
              style={{ background: "oklch(0.72 0.25 285)", color: "white", boxShadow: "0 2px 8px oklch(0.72 0.25 285 / 0.45)" }}
            >
              <ChevronUp size={14} />
            </button>
            <button
              type="button"
              onClick={() => scrollContainerRef.current?.scrollTo({ top: scrollContainerRef.current.scrollHeight, behavior: "smooth" })}
              title="Jump to the last beat"
              aria-label="Scroll to bottom"
              className="fixed bottom-24 right-5 z-30 w-7 h-7 rounded-md flex items-center justify-center transition-all hover:scale-105 active:scale-95"
              style={{ background: "oklch(0.72 0.25 285)", color: "white", boxShadow: "0 2px 8px oklch(0.72 0.25 285 / 0.45)" }}
            >
              <ChevronDown size={14} />
            </button>
          </>
        )}
      </main>

      {/* Fixed bottom bar */}
      {hasImageBeats && (
        <div
          className="fixed bottom-0 left-0 md:left-64 right-0 z-20 py-3"
          style={{ background: "var(--bg-header-2)", borderTop: "1px solid var(--bd-6)", backdropFilter: "blur(12px)" }}
        >
          <div className="mx-5 sm:px-8">
          <button
            onClick={() => { setNavigating(true); router.push(`/projects/${projectId}/voiceover`); }}
            disabled={anyRunning || navigating || !imageStepCompleteOnServer}
            title={
              imageStepCompleteOnServer
                ? undefined
                : "Finish the beats and image prompts first. Every beat needs a prompt before the voiceover step can use them."
            }
            className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed transition-all"
            style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
          >
            {navigating ? (
              <span className="flex items-center justify-center gap-2">
                <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                Loading…
              </span>
            ) : imageStepCompleteOnServer ? "Continue →" : "Finish the prompts to continue"}
          </button>
          </div>
        </div>
      )}

      {/* Reroute offer. Two shapes behind one button: paste-a-key for a client
          who has never set one, plain confirm for a client who has. */}
      {/* The only dark dialog in the app — every other one is white (see
          DialogContent's own note). twMerge lets the overrides below win over
          the white base classes. */}
      <Dialog open={rerouteFor !== null} onOpenChange={(open) => { if (!open && !switchingRoute) setRerouteFor(null); }}>
        <DialogContent className="sm:max-w-md bg-zinc-900 text-zinc-100 ring-zinc-700" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-zinc-50">
              {anthropicRouting?.hasKey ? "Use your Anthropic key?" : "Add your Anthropic key"}
            </DialogTitle>
            <DialogDescription className="text-zinc-400">
              {anthropicRouting?.hasKey
                ? "This step will run straight on your Anthropic account instead of through KIE, then retry. Images, video and voiceover stay on KIE."
                : "KIE resells Claude, so an outage there stops these steps. With your own Anthropic key they run direct and are billed by Anthropic in tokens. Images, video and voiceover stay on KIE."}
            </DialogDescription>
          </DialogHeader>
          {!anthropicRouting?.hasKey && (
            <div className="space-y-3">
              {/* Every link opens in a new tab: the user is mid-generation and
                  navigating away would lose the failed run's state. */}
              <ol className="space-y-1.5 text-xs text-zinc-400">
                {([
                  <>Sign up or log in at <ModalLink href="https://console.anthropic.com">console.anthropic.com</ModalLink>.</>,
                  <>Add credit under <ModalLink href="https://console.anthropic.com/settings/billing">Billing</ModalLink> — a key with no balance fails on the first call. Anthropic bills per token, so there is nothing to convert.</>,
                  <>Open <ModalLink href="https://console.anthropic.com/settings/keys">API Keys</ModalLink> → <b>Create Key</b> → copy it immediately (it is shown once).</>,
                  <>Paste it below and hit <b>Save and retry</b>.</>,
                ]).map((s, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="font-semibold text-zinc-500 shrink-0">{i + 1}.</span>
                    <span className="leading-relaxed">{s}</span>
                  </li>
                ))}
              </ol>
              <input
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={anthropicKeyDraft}
                onChange={(e) => setAnthropicKeyDraft(e.target.value)}
                placeholder="sk-ant-…"
                disabled={switchingRoute}
                className="w-full px-3 py-2 rounded-lg text-sm font-mono bg-zinc-800 border border-zinc-700 text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-zinc-500 disabled:opacity-50"
              />
              <p className="text-xs text-zinc-400">
                Stored on your account only. Switch back to KIE any time in{" "}
                <ModalLink href="/setup">Setup</ModalLink>.
              </p>
            </div>
          )}
          <DialogFooter className="bg-zinc-800/50 border-zinc-700">
            <button
              onClick={() => setRerouteFor(null)}
              disabled={switchingRoute}
              className="flex-1 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80 disabled:opacity-40 bg-zinc-800 text-zinc-200 border border-zinc-600"
            >
              Cancel
            </button>
            <button
              onClick={confirmReroute}
              disabled={switchingRoute}
              className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
              style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
            >
              {switchingRoute ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  Switching…
                </span>
              ) : anthropicRouting?.hasKey ? "Switch and retry" : "Save and retry"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={continueOpen} onOpenChange={setContinueOpen}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Done merging beats?</DialogTitle>
            <DialogDescription>
              Merging is only available here. Once you continue, these {beats.length} beat{beats.length === 1 ? "" : "s"} are
              what your prompts, images and voiceover get built from — make sure you&apos;re happy with the split.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setContinueOpen(false)}
              className="flex-1 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80"
              style={{ background: "oklch(1 0 0 / 0.06)", color: "var(--c-60)", border: "1px solid var(--bd-8)" }}
            >
              Keep merging
            </button>
            <button
              onClick={() => { setBeatsConfirmed(true); setContinueOpen(false); }}
              className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
            >
              Continue
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!regenTarget} onOpenChange={(open) => { if (!open && !regenerating) setRegenTarget(null); }}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {regenTarget === "image" ? "Regenerate image prompts?" : "Regenerate video prompts?"}
            </DialogTitle>
            <DialogDescription>
              {regenTarget === "image"
                ? fillMode
                  ? `This rewrites the image prompt on all ${beats.length} beat${beats.length === 1 ? "" : "s"} and clears any video prompts attached to them. Your beats and how you've merged them stay as they are. This can't be undone.`
                  : `This discards all ${beats.length} existing image beat${beats.length === 1 ? "" : "s"} (and any video prompts attached to them) and rebuilds them from your current script. This can't be undone.`
                : `This discards the existing video prompts on all ${videoBeats.length} beat${videoBeats.length === 1 ? "" : "s"} and rebuilds them. Image prompts and beat metadata stay intact. This can't be undone.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setRegenTarget(null)}
              disabled={regenerating}
              className="flex-1 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80 disabled:opacity-40"
              style={{ background: "oklch(1 0 0 / 0.06)", color: "var(--c-60)", border: "1px solid var(--bd-8)" }}
            >
              Cancel
            </button>
            <button
              onClick={confirmRegen}
              disabled={regenerating}
              className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
            >
              {regenerating ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  Clearing…
                </span>
              ) : "Regenerate"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!clearTarget} onOpenChange={(open) => { if (!open && !clearing) setClearTarget(null); }}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {clearTarget === "image" ? "Clear image prompts?" : "Clear video prompts?"}
            </DialogTitle>
            <DialogDescription>
              {clearTarget === "image"
                ? fillMode
                  ? `This removes the image prompt from all ${beats.length} beat${beats.length === 1 ? "" : "s"}, along with any video prompts attached to them. The beats themselves stay, so you won't have to split or merge them again. This can't be undone.`
                  : `This permanently removes all ${beats.length} image beat${beats.length === 1 ? "" : "s"} from the database. Video prompts attached to those beats will also be cleared. This can't be undone.`
                : `This removes the video prompts from all ${videoBeats.length} beat${videoBeats.length === 1 ? "" : "s"}. Image prompts and beat metadata stay intact. This can't be undone.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setClearTarget(null)}
              disabled={clearing}
              className="flex-1 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80 disabled:opacity-40"
              style={{ background: "oklch(1 0 0 / 0.06)", color: "var(--c-60)", border: "1px solid var(--bd-8)" }}
            >
              Cancel
            </button>
            <button
              onClick={confirmClear}
              disabled={clearing}
              className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
              style={{ background: "oklch(0.5 0.22 25)", color: "white" }}
            >
              {clearing ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  Clearing…
                </span>
              ) : "Clear"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bulkOpen} onOpenChange={(open) => { if (!open && !bulkRunning) setBulkOpen(false); }}>
        <DialogContent className="sm:max-w-2xl bg-zinc-900 text-zinc-100 ring-zinc-700" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle className="text-zinc-50">Merge beats</DialogTitle>
            <DialogDescription className="text-zinc-400">
              Merges short beats into a neighbour. Fewer, longer beats cost less to generate but match the narration less closely.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <label className="flex items-center justify-between gap-3 text-sm text-zinc-300">
              <span>Merge beats under</span>
              <span className="flex items-center gap-2">
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={bulkMinWords}
                  disabled={bulkRunning}
                  onChange={(e) => setBulkMinWords(Math.min(50, Math.max(1, Number(e.target.value) || 1)))}
                  className="w-20 rounded-lg px-2 py-1.5 text-sm bg-zinc-800 text-zinc-100 ring-1 ring-zinc-700 focus:ring-2 focus:ring-zinc-500 outline-none disabled:opacity-60"
                />
                <span className="text-zinc-400">words</span>
              </span>
            </label>

            <label className="flex items-center justify-between gap-3 text-sm text-zinc-300">
              <span>Merge into</span>
              <select
                value={bulkDirection}
                disabled={bulkRunning}
                onChange={(e) => setBulkDirection(e.target.value as "up" | "down" | "auto")}
                className="rounded-lg px-2 py-1.5 text-sm bg-zinc-800 text-zinc-100 ring-1 ring-zinc-700 focus:ring-2 focus:ring-zinc-500 outline-none disabled:opacity-60"
              >
                <option value="up">the beat before</option>
                <option value="down">the beat after</option>
                <option value="auto">Auto (AI decides)</option>
              </select>
            </label>

            <div className="rounded-lg px-3 py-2.5 text-sm bg-zinc-800 text-zinc-300 ring-1 ring-zinc-700">
              {bulkPlan.steps.length === 0
                ? `No beats under ${bulkMinWords} word${bulkMinWords === 1 ? "" : "s"}.`
                : bulkDirection === "auto"
                  ? `${bulkStubs.length} beat${bulkStubs.length === 1 ? "" : "s"} will be merged, each into the side the AI picks. ${beats.length} becomes ${bulkPlan.finalCount}.`
                  : `${bulkPlan.steps.length} beat${bulkPlan.steps.length === 1 ? "" : "s"} will be merged. ${beats.length} becomes ${bulkPlan.finalCount}.`}
            </div>

            {(bulkDirection === "auto" ? bulkStubs.map((s) => s.beatNumber) : bulkPlan.absorbedOriginals).length > 0 && (
              <div className="max-h-40 overflow-y-auto rounded-lg ring-1 ring-zinc-700 divide-y divide-zinc-800">
                {(bulkDirection === "auto" ? bulkStubs.map((s) => s.beatNumber) : bulkPlan.absorbedOriginals).map((n) => (
                  <div key={n} className="flex gap-2 px-3 py-1.5 text-xs text-zinc-400">
                    <span className="font-semibold text-zinc-500 shrink-0">{n}</span>
                    <span className="truncate">{beats.find((b) => b.beatNumber === n)?.scriptSegment || "(empty)"}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <DialogFooter className="bg-zinc-800/50 border-zinc-700">
            <button
              onClick={() => setBulkOpen(false)}
              disabled={bulkRunning}
              className="flex-1 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80 disabled:opacity-40 bg-zinc-800 text-zinc-200 ring-1 ring-zinc-600 hover:bg-zinc-700"
            >
              Cancel
            </button>
            <button
              onClick={runBulkMerge}
              disabled={bulkRunning || bulkPlan.steps.length === 0}
              className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
              style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
            >
              {bulkRunning ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  Merging…
                </span>
              ) : `Merge ${bulkPlan.steps.length || ""}`.trim()}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!mergeTarget} onOpenChange={(open) => { if (!open && !merging) setMergeTarget(null); }}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {mergeTarget && (mergeTarget.direction === "up"
                ? `Merge beat ${mergeTarget.beatNumber} into ${mergeTarget.beatNumber - 1}?`
                : `Merge beat ${mergeTarget.beatNumber + 1} into ${mergeTarget.beatNumber}?`)}
            </DialogTitle>
            <DialogDescription>
              {mergeTarget && (() => {
                const keep = mergeTarget.direction === "up" ? mergeTarget.beatNumber - 1 : mergeTarget.beatNumber;
                return `Beat ${keep} keeps its prompts. Beat ${keep + 1}'s are deleted. Can't be undone.`;
              })()}
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={mergeDraft}
            onChange={(e) => setMergeDraft(e.target.value)}
            disabled={merging}
            rows={4}
            className="w-full rounded-lg px-3 py-2 text-sm leading-relaxed bg-zinc-50 text-zinc-900 ring-1 ring-zinc-300 focus:ring-2 focus:ring-zinc-400 outline-none resize-y disabled:opacity-60"
          />
          <DialogFooter>
            <button
              onClick={() => setMergeTarget(null)}
              disabled={merging}
              className="flex-1 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80 disabled:opacity-40"
              style={{ background: "oklch(1 0 0 / 0.06)", color: "var(--c-60)", border: "1px solid var(--bd-8)" }}
            >
              Cancel
            </button>
            <button
              onClick={confirmMerge}
              disabled={merging || !mergeDraft.trim()}
              className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
              style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
            >
              {merging ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  Merging…
                </span>
              ) : "Merge"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
