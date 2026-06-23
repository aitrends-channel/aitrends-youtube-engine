"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { WizardNav } from "@/components/wizard/WizardNav";
import { StepCostCard } from "@/components/StepCostCard";
import { useProject } from "@/hooks/useProject";
import { toast } from "sonner";
import useSWR from "swr";
import type { KieModel, Beat } from "@/lib/types";
import { FullVoiceoverPreview } from "@/components/voiceover/FullVoiceoverPreview";
import { RotateCw } from "lucide-react";

// Per-beat voiceover step. Each beat shows its own row with status,
// playback, and per-beat retry. A bulk Generate button kicks off all
// stale beats in parallel (server-side concurrency cap respected).
//
// Status sources:
//   • The project's `beats` array carries voiceoverUrl / voiceoverStatus
//     and friends — that's the canonical source after the SSE stream
//     ends or on a fresh page load.
//   • While the SSE is in flight, per-beat status arriving from the
//     server takes precedence via an overlay map so the UI doesn't
//     wait for SWR's 5s poll to reflect each beat's progress.

interface PageProps { params: { projectId: string } }

const fetcher = (url: string) => fetch(url).then((r) => r.json());

type BeatStatus = "pending" | "queued" | "generating" | "done" | "failed";

interface LiveBeatState {
  status: BeatStatus;
  url?: string;
  error?: string;
}

// ── Voice picker (mirrors the generate page's VoiceOption) ──────────
function VoiceOption({
  model, selected, onSelect, isPlaying, onPlayToggle,
}: {
  model: KieModel; selected: boolean; onSelect: () => void;
  isPlaying: boolean; onPlayToggle: (id: string | null) => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (!isPlaying && audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
  }, [isPlaying]);
  useEffect(() => () => { audioRef.current?.pause(); }, []);
  function togglePreview(e: React.MouseEvent) {
    e.stopPropagation();
    if (!model.previewUrl) return;
    if (isPlaying) {
      onPlayToggle(null);
    } else {
      onSelect();
      const audio = new Audio(model.previewUrl);
      audioRef.current = audio;
      audio.onended = () => onPlayToggle(null);
      audio.onerror = () => onPlayToggle(null);
      audio.play().catch(() => onPlayToggle(null));
      onPlayToggle(model.id);
    }
  }
  return (
    <div
      role="button"
      onClick={onSelect}
      className="cursor-pointer p-3 rounded-xl transition-all select-none"
      style={selected ? {
        background: "oklch(0.72 0.25 285 / 0.1)",
        border: "1px solid oklch(0.72 0.25 285 / 0.3)",
        color: "var(--c-90)",
      } : {
        background: "var(--bg-input)",
        border: "1px solid var(--bd-7)",
        color: "var(--c-60)",
      }}
    >
      <div className="flex items-center gap-2">
        <p className="font-medium text-xs flex-1 truncate">{model.name}</p>
        {model.previewUrl && (
          <button
            onClick={togglePreview}
            title={isPlaying ? "Stop preview" : "Preview voice"}
            className="w-6 h-6 rounded flex items-center justify-center shrink-0 transition-colors"
            style={{
              background: isPlaying ? "oklch(0.72 0.25 285 / 0.15)" : "oklch(0.2 0 0)",
              color: isPlaying ? "oklch(0.72 0.25 285)" : "var(--c-45)",
              border: "1px solid var(--bd-10)",
            }}
          >
            {isPlaying ? (
              <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
                <rect x="0.5" y="0" width="2.5" height="8" rx="0.5" />
                <rect x="5" y="0" width="2.5" height="8" rx="0.5" />
              </svg>
            ) : (
              <svg width="7" height="9" viewBox="0 0 7 9" fill="currentColor">
                <path d="M0 0.5L7 4.5L0 8.5V0.5Z" />
              </svg>
            )}
          </button>
        )}
      </div>
      {model.tags && model.tags.length > 0 && (
        <div className="flex gap-1 mt-1.5 flex-wrap">
          {model.tags.map((tag) => (
            <span key={tag} className="px-1.5 py-0.5 rounded text-xs"
              style={{ background: "var(--bg-track)", color: "var(--c-45)" }}>
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Status pill ─────────────────────────────────────────────────────
function StatusPill({ status }: { status: BeatStatus }) {
  const style = {
    pending:    { bg: "oklch(0.7 0.18 25 / 0.10)",    col: "oklch(0.75 0.18 25)", label: "Pending" },
    queued:     { bg: "oklch(0.72 0.16 70 / 0.12)",   col: "oklch(0.85 0.12 70)", label: "Queued" },
    generating: { bg: "oklch(0.72 0.25 285 / 0.12)",  col: "oklch(0.72 0.25 285)", label: "Generating" },
    done:       { bg: "oklch(0.55 0.15 145 / 0.15)",  col: "oklch(0.7 0.15 145)", label: "Done" },
    failed:     { bg: "oklch(0.6 0.22 25 / 0.12)",    col: "oklch(0.7 0.2 25)",   label: "Failed" },
  }[status];
  return (
    <span className="text-[11px] font-medium px-2 py-0.5 rounded inline-flex items-center gap-1.5"
      style={{ background: style.bg, color: style.col }}>
      {/* Loading spinner is reserved for beats that the worker pool
          is actively processing. "Queued" rows are pre-marked
          upfront (BATCH_SIZE-at-a-time used to limit this; the
          worker-pool change made the queue span the whole stale
          set), so a spinning queued pill on 100+ rows misleads the
          user into thinking every beat is in flight. Static dot for
          queued, spinner only for generating. */}
      {status === "queued" && (
        <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: "currentColor", opacity: 0.65 }} />
      )}
      {status === "generating" && (
        <span className="inline-block w-2 h-2 rounded-full border-2 border-current border-t-transparent animate-spin" />
      )}
      {style.label}
    </span>
  );
}

export default function VoiceoverPage({ params }: PageProps) {
  const { projectId } = params;
  const router = useRouter();
  const { project, mutate } = useProject(projectId);
  const { data: ttsModels } = useSWR<KieModel[]>("/api/kie/models?type=tts", fetcher);

  const beats: Beat[] = useMemo(() => (project?.beats ?? []) as Beat[], [project]);
  const projectVoiceId = (project?.tts_voice_id as string | null | undefined) ?? null;

  // Voice picker state — defaults to the project's saved voice (i.e.
  // the voice that was actually used to generate any existing beats),
  // else first model of the active gender tab.
  const [selectedVoice, setSelectedVoice] = useState<string | null>(null);
  const [voiceTab, setVoiceTab] = useState<"female" | "male">("female");
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  // Sticky bit so a subsequent project SWR update doesn't overwrite an
  // explicit user pick. Only the very first resolution honors
  // projectVoiceId / auto-pick; after that the picker owns the state.
  const voiceResolvedRef = useRef(false);
  useEffect(() => {
    if (voiceResolvedRef.current) return;
    // Wait for the project to load so we know whether tts_voice_id
    // exists. Without this, ttsModels can arrive first and auto-pick
    // a different voice before projectVoiceId ever shows up — the
    // banner then displays the wrong voice and the staleness math
    // thinks every done beat needs regenerating.
    if (project === undefined) return;
    if (projectVoiceId) {
      setSelectedVoice(projectVoiceId);
      voiceResolvedRef.current = true;
      return;
    }
    // No saved voice → fall back to the first voice in the active
    // tab once the catalog is available.
    if (!ttsModels?.length) return;
    const firstInTab = ttsModels.find((m) => m.tags?.[0]?.toLowerCase() === voiceTab);
    if (firstInTab) {
      setSelectedVoice(firstInTab.id);
      voiceResolvedRef.current = true;
    }
  }, [project, projectVoiceId, ttsModels, voiceTab]);

  // Live overlay — per-beat state from the SSE stream during a run,
  // takes precedence over the project's persisted state until the
  // stream ends and SWR catches up.
  const [liveBeats, setLiveBeats] = useState<Map<number, LiveBeatState>>(new Map());
  const [generating, setGenerating] = useState(false);
  const [stopped, setStopped] = useState(false);
  // Mirror `stopped` into a ref so the SSE handler (a long-lived async
  // closure) reads the latest value when deciding whether to auto-
  // continue after a batch completes. Reading `stopped` directly would
  // return whatever value was captured when runGeneration() started.
  const stoppedRef = useRef(false);
  useEffect(() => { stoppedRef.current = stopped; }, [stopped]);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  // AbortController for the in-flight SSE fetch. Stop aborts it; the
  // server detects the closed stream and stops queueing further batches.
  // Any beats already in flight in the current batch will run to
  // completion (their KIE call is already going).
  const abortRef = useRef<AbortController | null>(null);

  function effectiveStatus(b: Beat): BeatStatus {
    const live = liveBeats.get(b.beatNumber);
    if (live) return live.status;
    // If the beat has audio on disk, it's done — regardless of any
    // stale "queued"/"generating" label that may have been left on
    // the row by an older run. This is a safety net for orphaned
    // status writes; the DB cleanup pass in the route handles new
    // runs, but we want existing data to render correctly too.
    if (b.voiceoverUrl) return "done";
    const s = b.voiceoverStatus;
    // "generating" is included so that a browser refresh during a
    // run keeps showing the live status on beats the server is
    // still processing — the function continues server-side past
    // a client disconnect (maxDuration=800), but without this pass-
    // through the page rendered them as "pending" and looked stuck.
    if (s === "queued" || s === "generating" || s === "done" || s === "failed") return s;
    return "pending";
  }

  function effectiveUrl(b: Beat): string | undefined {
    return liveBeats.get(b.beatNumber)?.url ?? b.voiceoverUrl;
  }

  function effectiveError(b: Beat): string | undefined {
    return liveBeats.get(b.beatNumber)?.error ?? b.voiceoverError;
  }

  // A beat is "stale" if it needs regen — same logic the server uses.
  function isStale(b: Beat, voiceId: string | null): boolean {
    if (!b.scriptSegment?.trim()) return false;
    if (!b.voiceoverUrl) return true;
    if (b.voiceoverStatus === "failed" || b.voiceoverStatus === "queued") return true;
    if (voiceId && b.voiceoverVoiceId !== voiceId) return true;
    // Skip script-hash check on the client — the server has the
    // canonical hash; if the script changed we'd see the mismatch
    // via the voiceover_url being from an older render.
    return false;
  }

  const totalBeats = beats.length;
  const doneCount = beats.filter((b) => effectiveStatus(b) === "done").length;
  const failedCount = beats.filter((b) => effectiveStatus(b) === "failed").length;
  // "Queued" here means a row left in voiceover_status="queued" from a
  // previous run that was cancelled/orphaned — selectStaleBeats picks
  // those up too so they get retried, the user doesn't have to.
  const queuedCount = beats.filter((b) => effectiveStatus(b) === "queued").length;
  const pendingCount = beats.filter((b) => effectiveStatus(b) === "pending").length;
  const staleCount = beats.filter((b) => isStale(b, selectedVoice)).length;
  // "Remaining" = beats that don't yet have a saved voiceover at all.
  // Used for the button label so a partially-complete project doesn't
  // show "Generate {total}" after a refresh — the done beats really do
  // exist on disk, they shouldn't be counted as work the user is about
  // to do. (staleCount can match totalBeats when the picked voice
  // differs from what the done beats were generated with — that's a
  // separate "Regenerate" intent and is signalled in the button text.)
  const remainingCount = beats.filter((b) => !b.voiceoverUrl).length;
  const allDone = totalBeats > 0 && doneCount === totalBeats;

  // The route now loops through all stale beats in one request (the
  // server claims a voiceover_active_run_id and walks the full set
  // server-side), so the client doesn't need to fire follow-up
  // calls between batches anymore. Browser refresh during a run no
  // longer halts the queue.
  async function runGeneration(opts: { beatNumbers?: number[] } = {}) {
    if (!selectedVoice) { toast.error("Pick a voice first"); return; }
    if (!totalBeats) { toast.error("No beats — run Prompts step first"); return; }
    if (generating) return;
    setGenerating(true);
    setStopped(false);
    setProgress(null);
    setStatusMessage("Starting…");
    setLiveBeats(new Map());

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch("/api/generate/tts/beats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          voiceId: selectedVoice,
          ...(opts.beatNumbers ? { beatNumbers: opts.beatNumbers } : {}),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error("Failed to start voiceover generation");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let receivedTerminal = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let ev: { type?: string; message?: string; current?: number; total?: number; beatNumber?: number; status?: BeatStatus; url?: string; error?: string };
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          if (ev.type === "status") setStatusMessage(ev.message ?? "");
          else if (ev.type === "progress") setProgress({ current: ev.current ?? 0, total: ev.total ?? 0 });
          else if (ev.type === "beat" && typeof ev.beatNumber === "number" && ev.status) {
            setLiveBeats((prev) => {
              const next = new Map(prev);
              next.set(ev.beatNumber!, { status: ev.status!, url: ev.url, error: ev.error });
              return next;
            });
          } else if (ev.type === "done") {
            receivedTerminal = true;
            const generated = ev.current ?? 0;
            void generated;
            const total = ev.total ?? 0;
            const remaining = (ev as { remaining?: number }).remaining ?? 0;
            const failedCount = (ev as { failed?: number }).failed ?? 0;
            const wasStopped = (ev as { stopped?: boolean }).stopped === true;
            if (total === 0) toast.success("Voiceovers already up to date");
            else if (wasStopped) {
              // Server-side stop honored. Remaining beats stay as
              // "pending"; user can click Generate again to resume.
              toast.info(`Stopped — ${generated || total - remaining} done, ${remaining} pending.`);
            }
            else if (failedCount > 0) toast.error(`${failedCount} of ${total} failed`);
            else {
              toast.success(`Generated ${total} beat voiceover${total === 1 ? "" : "s"}`);
            }
          } else if (ev.type === "error") {
            receivedTerminal = true;
            throw new Error(ev.message ?? "Generation failed");
          }
        }
      }
      if (!receivedTerminal) throw new Error("Stream ended unexpectedly — try again.");
      await mutate();
    } catch (err) {
      // AbortError fires when the user clicks Stop — that's an
      // intentional cancel, not a failure, so suppress the toast.
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (!isAbort) {
        toast.error(err instanceof Error ? err.message : "Generation failed");
      }
      // "Stream ended unexpectedly" means the SSE connection dropped
      // before the route emitted its terminal event — almost always a
      // Vercel function timeout (800s) or a network blip. In either
      // case the route's `finally` didn't get to clear
      // voiceover_active_run_id, so the UI would keep treating the
      // run as in-flight (via serverGenerationActive) until the
      // 15-minute staleness check expires it. Clear the flag
      // ourselves so the spinner + "Generating" pill go away
      // immediately. The optimistic SWR mutate flips the UI this
      // frame; the PATCH is the durable write.
      const streamEnded = err instanceof Error && err.message.includes("Stream ended unexpectedly");
      if (streamEnded) {
        await mutate(
          (cur: Record<string, unknown> | undefined) => cur ? { ...cur, voiceover_active_run_id: null, voiceover_run_started_at: null } : cur,
          { revalidate: false }
        );
        try {
          await fetch(`/api/projects/${projectId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ voiceover_active_run_id: null, voiceover_run_started_at: null }),
          });
        } catch (patchErr) {
          console.warn("[voiceover] failed to clear active_run_id after stream-ended:", patchErr);
        }
      }
    } finally {
      setGenerating(false);
      setProgress(null);
      setStatusMessage("");
      abortRef.current = null;
      // Clear live overlay so DB-backed state takes over once SWR
      // refreshes — avoids a stale local "done" carrying over after
      // a project change.
      setLiveBeats(new Map());
      await mutate();
    }
  }

  async function stopGeneration() {
    // PATCH the persistent stop flag first so the server's between-
    // batch check picks it up — that's what actually halts a queue
    // running past this client (e.g. across a refresh). Then abort
    // the local SSE stream if one is open so the UI doesn't keep
    // receiving updates for the in-flight batch that's still
    // finishing.
    setStopped(true);
    // Optimistic SWR update — without this, the pill change waits for
    // the PATCH round-trip + the next SWR poll, which felt like the
    // page was stuck until a manual refresh. Mutating the cache with
    // revalidate:false applies the flag locally so React re-renders
    // this frame; the PATCH below is the canonical write, and the
    // mutate() after it does the revalidation.
    await mutate(
      (cur: Record<string, unknown> | undefined) => cur ? { ...cur, voiceover_stop_requested: true } : cur,
      { revalidate: false }
    );
    try {
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voiceover_stop_requested: true }),
      });
      await mutate();
    } catch (err) {
      console.warn("[voiceover] stop PATCH failed:", err);
    }
    abortRef.current?.abort();
  }

  // Server-side generation is "active" when the project's
  // voiceover_active_run_id is set. The TTS beats route claims the
  // run id on entry and clears it on exit (success / stop / error),
  // so this is the canonical "is a run in flight" signal — survives
  // browser refresh and doesn't drift when the server is between
  // batches (when no beat is currently "generating" but the next
  // batch is about to start).
  //
  // Also surface a beat-level count for the in-progress pill so we
  // can say "Processing already in-flight N beats". The worker pool
  // pre-marks the whole stale set as "queued" upfront, so counting
  // queued + generating would inflate this to the entire remaining
  // queue (e.g. "Processing 145 beats" when only 5 are actually in
  // flight). Restrict to "generating" — that's the set the worker
  // pool is actually encoding right now, capped at BATCH_SIZE.
  const projectRunActive = !!(project as { voiceover_active_run_id?: string | null } | undefined)?.voiceover_active_run_id;
  const projectStopRequested = !!(project as { voiceover_stop_requested?: boolean } | undefined)?.voiceover_stop_requested;
  const projectRunStartedAt = (project as { voiceover_run_started_at?: string | null } | undefined)?.voiceover_run_started_at ?? null;
  const inProgressBeatsCount = beats.filter(
    (b) => b.voiceoverStatus === "generating"
  ).length;
  // Vercel kills the TTS route at 800s. When that happens its
  // `finally` block doesn't get to run, so voiceover_active_run_id
  // stays set in the DB and the UI thinks generation is still
  // happening. Detect this by comparing the claim timestamp against
  // a window comfortably past the function timeout — anything older
  // than 15 minutes is a stuck phantom run, not a live one. NULL
  // started_at on a set run_id is treated as stale too (it's the
  // exact pre-migration state of any project that got stuck by this
  // bug), so users can recover without manual DB cleanup.
  const RUN_STALE_AFTER_MS = 15 * 60 * 1000;
  const serverRunIsStale = projectRunActive && (
    !projectRunStartedAt
    || (Date.now() - new Date(projectRunStartedAt).getTime()) > RUN_STALE_AFTER_MS
  );
  const serverGenerationActive = projectRunActive && !serverRunIsStale;
  // Treat the page as "generating" whenever EITHER signal is true.
  // Hides the Generate-remaining button during a server-only run so
  // refreshing mid-generation doesn't make it look like the user has
  // to click again to resume — the route will keep queuing batches
  // server-side and SWR will surface the new state.
  const effectivelyGenerating = generating || serverGenerationActive;

  // Per-beat regen is intentionally decoupled from the bulk-run state.
  // It hits the same TTS beats endpoint with skipRunClaim:true so the
  // route doesn't touch voiceover_active_run_id and the page's
  // serverGenerationActive stays false during a single-beat regen.
  // The state below tracks WHICH beat is being regenerated and whether
  // the user has stopped it; the per-beat card uses this to render
  // beat-scoped Stop / Resume controls.
  const [perBeatRegen, setPerBeatRegen] = useState<{ beatNumber: number; status: "running" | "stopped" } | null>(null);
  const perBeatAbortRef = useRef<AbortController | null>(null);

  async function startPerBeatRegen(beatNumber: number) {
    if (!selectedVoice) { toast.error("Pick a voice first"); return; }
    setPerBeatRegen({ beatNumber, status: "running" });
    const ctrl = new AbortController();
    perBeatAbortRef.current = ctrl;
    try {
      const res = await fetch("/api/generate/tts/beats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          voiceId: selectedVoice,
          beatNumbers: [beatNumber],
          // Run independently of the bulk-run state.
          skipRunClaim: true,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error("Failed to start per-beat regen");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let ev: { type?: string; beatNumber?: number; status?: BeatStatus; url?: string; error?: string };
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          if (ev.type === "beat" && typeof ev.beatNumber === "number" && ev.status) {
            setLiveBeats((prev) => {
              const next = new Map(prev);
              next.set(ev.beatNumber!, { status: ev.status!, url: ev.url, error: ev.error });
              return next;
            });
          } else if (ev.type === "error") {
            throw new Error((ev as { message?: string }).message ?? "Regen failed");
          }
        }
      }
      await mutate();
      // Only clear the regen state if we weren't stopped — a stop
      // transition flips status to "stopped" and shows the Resume
      // button; the run-completion path here is the success case.
      setPerBeatRegen((cur) => (cur && cur.status === "running" ? null : cur));
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (!isAbort) {
        toast.error(err instanceof Error ? err.message : "Regen failed");
        setPerBeatRegen(null);
      }
    } finally {
      perBeatAbortRef.current = null;
      // Clear the live overlay for this beat so DB-backed state takes
      // over once SWR refreshes.
      setLiveBeats((prev) => {
        const next = new Map(prev);
        next.delete(beatNumber);
        return next;
      });
    }
  }

  function stopPerBeatRegen() {
    perBeatAbortRef.current?.abort();
    setPerBeatRegen((cur) => (cur ? { ...cur, status: "stopped" } : null));
  }

  function resumePerBeatRegen() {
    if (!perBeatRegen) return;
    void startPerBeatRegen(perBeatRegen.beatNumber);
  }

  // Failed-beat retry is a one-shot fix (no audio to lose), so it runs
  // directly with no confirm. Regenerating a done beat overwrites an
  // existing voiceover and costs KIE credits, so we ask first.
  function retryOne(beatNumber: number, currentStatus: BeatStatus) {
    if (effectivelyGenerating) { toast.error("Wait for the current run to finish"); return; }
    if (perBeatRegen) { toast.error("Another beat is being regenerated"); return; }
    if (currentStatus === "failed") {
      void startPerBeatRegen(beatNumber);
      return;
    }
    setConfirm({
      title: `Regenerate beat ${beatNumber}?`,
      body: (
        <>
          This will overwrite the existing voiceover for beat{" "}
          <span className="font-semibold" style={{ color: "var(--c-80)" }}>#{beatNumber}</span>
          {" "}and re-render it with the selected voice. The current audio for this beat will be replaced.
        </>
      ),
      footnote: "KIE credits will be charged for this regeneration.",
      icon: "↻",
      iconColor: "oklch(0.72 0.25 285)",
      iconBg: "oklch(0.72 0.25 285 / 0.12)",
      iconBorder: "oklch(0.72 0.25 285 / 0.3)",
      confirmLabel: `Regenerate beat ${beatNumber}`,
      confirmBg: "oklch(0.72 0.25 285)",
      onConfirm: async () => {
        setConfirm(null);
        await startPerBeatRegen(beatNumber);
      },
    });
  }

  const [dedupingOverlap, setDedupingOverlap] = useState(false);
  async function fixOverlappingText() {
    if (generating || dedupingOverlap) return;
    setDedupingOverlap(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/beats/dedupe-overlap`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Fix failed");
      if (data.fixed === 0) {
        toast.success("No overlapping text found — beats are already clean.");
      } else {
        toast.success(`Cleaned ${data.fixed} beat${data.fixed === 1 ? "" : "s"} of overlapping text. Regenerate to update audio.`);
        await mutate();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Fix failed");
    } finally {
      setDedupingOverlap(false);
    }
  }

  const [clearing, setClearing] = useState(false);

  // Single confirm-dialog state: holds either null (closed) or a config
  // object describing the title, body, button copy, and the callback
  // to fire on confirm. Both the Clear and Regenerate-all flows feed
  // into the same modal component below, just with different props.
  type ConfirmConfig = {
    title: string;
    body: React.ReactNode;
    footnote?: string;
    icon: string;
    iconColor: string;
    iconBg: string;
    iconBorder: string;
    confirmLabel: string;
    confirmBg: string;
    onConfirm: () => void | Promise<void>;
  };
  const [confirm, setConfirm] = useState<ConfirmConfig | null>(null);

  async function clearAll() {
    setConfirm(null);
    setClearing(true);
    try {
      const res = await fetch("/api/generate/tts/beats/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Clear failed");
      toast.success(`Cleared ${data.cleared ?? 0} beat${data.cleared === 1 ? "" : "s"}`);
      setStopped(false);
      setLiveBeats(new Map());
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Clear failed");
    } finally {
      setClearing(false);
    }
  }

  function openClearConfirm() {
    if (generating || clearing) return;
    if (doneCount === 0) { toast.error("Nothing to clear"); return; }
    setConfirm({
      title: "Clear all voiceovers?",
      body: (
        <>
          Deletes <span className="font-semibold" style={{ color: "var(--c-80)" }}>
            {doneCount} generated voiceover{doneCount === 1 ? "" : "s"}
          </span> from storage and resets every beat to{" "}
          <span className="font-semibold" style={{ color: "var(--c-80)" }}>Pending</span>.
        </>
      ),
      footnote: "This cannot be undone — you'll need to regenerate from scratch.",
      icon: "!",
      iconColor: "oklch(0.7 0.2 25)",
      iconBg: "oklch(0.6 0.22 25 / 0.12)",
      iconBorder: "oklch(0.6 0.22 25 / 0.3)",
      confirmLabel: `Clear ${doneCount} beat${doneCount === 1 ? "" : "s"}`,
      confirmBg: "oklch(0.6 0.22 25)",
      onConfirm: clearAll,
    });
  }

  function openRegenConfirm() {
    if (generating || clearing) return;
    if (!selectedVoice) { toast.error("Pick a voice first"); return; }
    if (doneCount === 0) {
      // Nothing on file — Regenerate is just a normal first-time run.
      runGeneration();
      return;
    }
    setConfirm({
      title: "Regenerate all voiceovers?",
      body: (
        <>
          This will overwrite <span className="font-semibold" style={{ color: "var(--c-80)" }}>
            {doneCount} existing voiceover{doneCount === 1 ? "" : "s"}
          </span> and re-render every beat with the selected voice. Your current audio for these beats will be replaced.
        </>
      ),
      footnote: "KIE credits will be charged for each regenerated beat.",
      icon: "↻",
      iconColor: "oklch(0.72 0.25 285)",
      iconBg: "oklch(0.72 0.25 285 / 0.12)",
      iconBorder: "oklch(0.72 0.25 285 / 0.3)",
      confirmLabel: `Regenerate ${totalBeats} beat${totalBeats === 1 ? "" : "s"}`,
      confirmBg: "oklch(0.72 0.25 285)",
      onConfirm: async () => {
        setConfirm(null);
        // Pass every beat number explicitly so selectStaleBeats is
        // bypassed and every beat is re-rendered, regardless of its
        // current done state.
        await runGeneration({ beatNumbers: beats.map((b) => b.beatNumber) });
      },
    });
  }

  // Esc closes the active confirm dialog.
  useEffect(() => {
    if (!confirm) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setConfirm(null); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm]);

  const filteredVoices = useMemo(
    () => (ttsModels ?? []).filter((m) => m.tags?.[0]?.toLowerCase() === voiceTab),
    [ttsModels, voiceTab],
  );

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "var(--bg-page-2)" }}>
      <WizardNav projectId={projectId} currentState={9} highestState={project?.current_state} channelName={project?.channel_name} />

      <main className="flex-1 flex flex-col overflow-hidden pt-[105px] md:pt-0">
        {/* Header */}
        <div className="shrink-0 sm:px-8 py-4 sm:py-5"
          style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}>
          <div>
            <h1 className="font-bold text-base sm:text-lg">Voiceover</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              One narration clip per beat. Each beat&apos;s clip is the timing source for its visual — no matcher, no drift.
            </p>
            <div className="mt-3">
              <StepCostCard projectId={projectId} column="voiceover" />
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pb-[70px]">
        <div className="py-4 sm:p-8 pb-24 space-y-6">

          {/* Voice picker */}
          <div className="rounded-2xl p-5" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
            <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>
              Voice
            </p>
            <div className="flex gap-1 mb-3">
              {(["female", "male"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setVoiceTab(tab)}
                  disabled={effectivelyGenerating}
                  className="flex-1 px-2 py-1.5 rounded-lg text-xs font-medium capitalize transition-all disabled:opacity-40"
                  style={voiceTab === tab ? {
                    background: "oklch(0.72 0.25 285 / 0.15)",
                    border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                    color: "oklch(0.88 0.12 285)",
                  } : {
                    background: "var(--bg-input)",
                    border: "1px solid var(--bd-7)",
                    color: "var(--c-50)",
                  }}
                >{tab}</button>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-60 overflow-y-auto pr-1">
              {!ttsModels && <p className="text-xs px-1" style={{ color: "var(--c-40)" }}>Loading voices…</p>}
              {ttsModels && filteredVoices.length === 0 && (
                <p className="text-xs px-1" style={{ color: "var(--c-40)" }}>No {voiceTab} voices available</p>
              )}
              {filteredVoices.map((m) => (
                <VoiceOption
                  key={m.id}
                  model={m}
                  selected={selectedVoice === m.id}
                  onSelect={() => setSelectedVoice(m.id)}
                  isPlaying={previewingId === m.id}
                  onPlayToggle={setPreviewingId}
                />
              ))}
            </div>
          </div>

          {project === undefined ? (
            // Project still loading — only the beats list / bulk panel
            // depends on it. Voice picker above renders independently
            // from its own SWR call, so we scope the loading state to
            // this section instead of taking over the whole page.
            <div className="rounded-2xl p-10 flex flex-col items-center gap-3"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
              <span className="block w-7 h-7 border-2 rounded-full animate-spin"
                style={{ borderColor: "oklch(0.72 0.25 285 / 0.3)", borderTopColor: "oklch(0.72 0.25 285)" }} />
              <p className="text-sm font-medium" style={{ color: "var(--c-60)" }}>Loading voiceover beats…</p>
              <p className="text-xs" style={{ color: "var(--c-40)" }}>
                Fetching beats and checking what&apos;s already on file.
              </p>
            </div>
          ) : (
          <>
          {/* Bulk action panel */}
          <div className="rounded-2xl p-5 space-y-3" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
            {/* Selected-voice banner — sits above the count/action row
                so the user always sees which voice the next batch will
                use, right next to the beats list (the most relevant
                context). Resolves the saved id against the live models
                catalog so the name (e.g. "Bella · female") shows
                instead of the opaque id. */}
            {(() => {
              const model = selectedVoice ? ttsModels?.find((m) => m.id === selectedVoice) : null;
              const tag = model?.tags?.[0];
              return (
                <div
                  className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl"
                  style={{ background: "oklch(0.72 0.25 285 / 0.08)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}
                  title={selectedVoice ? `Voice id: ${selectedVoice}` : undefined}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] uppercase tracking-wider font-semibold shrink-0" style={{ color: "oklch(0.78 0.12 285)" }}>
                      Voice
                    </span>
                    <span className="text-sm font-semibold truncate" style={{ color: "oklch(0.92 0.08 285)" }}>
                      {model?.name ?? (selectedVoice
                        ? (ttsModels ? "Unknown voice" : "Loading…")
                        : "None selected")}
                    </span>
                    {tag && (
                      <span className="text-xs capitalize shrink-0" style={{ color: "oklch(0.78 0.12 285 / 0.8)" }}>
                        · {tag}
                      </span>
                    )}
                  </div>
                </div>
              );
            })()}
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold text-sm">
                  {totalBeats === 0 ? "No beats yet" : allDone ? "All beats ready" : `${doneCount} of ${totalBeats} beats done`}
                </p>
                <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
                  {totalBeats === 0 ? (
                    "Run the Prompts step first."
                  ) : (
                    <>
                      {/* Explicit breakdown: surface every category so the
                          user can see what's already on file vs what the
                          next click will touch. Categories with zero
                          beats are dropped to keep the line short. */}
                      {[
                        doneCount > 0 && `${doneCount} done`,
                        failedCount > 0 && `${failedCount} failed`,
                        queuedCount > 0 && `${queuedCount} queued`,
                        pendingCount > 0 && `${pendingCount} pending`,
                      ].filter(Boolean).join(" · ")}
                      {staleCount > 0 && doneCount > 0 && (
                        <> · <span style={{ color: "oklch(0.6 0.15 145)" }}>{doneCount} already done will be kept</span></>
                      )}
                    </>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {/* Fix overlap: walks every beat and trims any leading
                    text that duplicates the previous beat's tail. Safe
                    to run multiple times — does nothing when there's
                    no overlap left. Doesn't touch audio files.
                    Hidden entirely while a server-side run is still
                    finishing (post-refresh state) so the in-progress
                    pill stands alone with no competing controls. */}
                {!serverGenerationActive && (
                <button
                  onClick={fixOverlappingText}
                  disabled={effectivelyGenerating || dedupingOverlap || totalBeats === 0}
                  title="Scan every beat and trim text that duplicates the previous beat's ending. Does not touch existing audio — regenerate to apply the cleaned text."
                  className="px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-40 transition-all"
                  style={{
                    background: "transparent",
                    color: "var(--c-60)",
                    border: "1px solid var(--bd-7)",
                  }}
                >
                  {dedupingOverlap ? "Fixing…" : "Fix overlap"}
                </button>
                )}
                {/* Clear: wipes every beat's voiceover from R2 + DB.
                    Disabled while a run is in flight (would race with
                    in-flight writes) or when there's nothing to delete. */}
                <button
                  onClick={openClearConfirm}
                  disabled={effectivelyGenerating || clearing || doneCount === 0}
                  title={doneCount === 0
                    ? "No generated voiceovers to clear"
                    : `Deletes all ${doneCount} generated voiceover${doneCount === 1 ? "" : "s"} from storage and resets every beat to Pending`}
                  className="px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-40 transition-all"
                  style={{
                    background: "transparent",
                    color: "oklch(0.7 0.2 25)",
                    border: "1px solid oklch(0.6 0.22 25 / 0.4)",
                  }}
                >
                  {clearing ? "Clearing…" : "Clear"}
                </button>
                {/* Stop button only shows while the local SSE stream
                    is alive AND Stop hasn't been requested yet. The
                    moment Stop is clicked, projectStopRequested goes
                    true (optimistic SWR update) and this branch falls
                    through to the serverGenerationActive pill below —
                    which now reads "Processing already queued N
                    beats". No wait for the fetch's finally block. */}
                {generating && !projectStopRequested ? (
                  <button
                    onClick={stopGeneration}
                    title="Stop after the current batch finishes"
                    className="px-4 py-2 rounded-lg text-sm font-semibold transition-all"
                    style={{ background: "oklch(0.6 0.22 25)", color: "var(--bg-page-2)" }}
                  >
                    <span className="flex items-center gap-2">
                      <span className="w-3.5 h-3.5 rounded-sm" style={{ background: "currentColor" }} />
                      Stop
                    </span>
                  </button>
                ) : serverGenerationActive ? (
                  // Hoisted above the stopped/Resume branch so a
                  // server-side run that's still winding down (post-
                  // Stop or post-refresh) always wins over the local
                  // "Resume N" fallback. Once the run id clears, this
                  // falls through to the Resume / Generate branches.
                  <div className="flex items-center gap-2">
                    <div
                      className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
                      title={projectStopRequested
                        ? "Stop received — no new beats will start, but the worker pool's in-flight KIE calls will still finish."
                        : "Voiceover generation is running on the server. The page will update as each beat completes."}
                      style={{ background: "oklch(0.72 0.25 285 / 0.1)", border: "1px solid oklch(0.72 0.25 285 / 0.3)", color: "oklch(0.88 0.12 285)" }}
                    >
                      <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                      <span className="font-medium">
                        {projectStopRequested
                          ? `Finishing ${inProgressBeatsCount} in-flight beat${inProgressBeatsCount === 1 ? "" : "s"}`
                          : "Generating…"}
                      </span>
                    </div>
                    {!projectStopRequested && (
                      <button
                        onClick={stopGeneration}
                        title="Stop after the current batch finishes"
                        className="px-4 py-2 rounded-lg text-sm font-semibold transition-all"
                        style={{ background: "oklch(0.6 0.22 25)", color: "var(--bg-page-2)" }}
                      >
                        <span className="flex items-center gap-2">
                          <span className="w-3.5 h-3.5 rounded-sm" style={{ background: "currentColor" }} />
                          Stop
                        </span>
                      </button>
                    )}
                  </div>
                ) : stopped && staleCount > 0 ? (
                  <button
                    onClick={() => runGeneration()}
                    disabled={!totalBeats || !selectedVoice}
                    title={`Resumes voiceover generation for the remaining ${staleCount} beat${staleCount === 1 ? "" : "s"}`}
                    className="px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 transition-all"
                    style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                  >
                    {`Resume ${staleCount} beat${staleCount === 1 ? "" : "s"}`}
                  </button>
                ) : (() => {
                  // Three button modes:
                  //   1. Some beats missing audio + some already done → "Generate remaining N beats"
                  //      (server's selectStaleBeats will still pick up
                  //       voice-mismatched done beats too, but the user-
                  //       facing count reflects only the truly missing
                  //       work so a 50/100 refresh doesn't read as a
                  //       full restart.)
                  //   2. All beats missing audio (fresh run) → "Generate N beats"
                  //   3. All beats have audio but staleCount > 0 (voice / script
                  //      changed since generation) → "Regenerate N beats"
                  //   4. Nothing stale at all → "Regenerate all" (opens the confirm)
                  const mode =
                    staleCount === 0 ? "regen-all" :
                    remainingCount > 0 && doneCount > 0 ? "remaining" :
                    remainingCount > 0 ? "fresh" :
                    "stale-regen";
                  const label =
                    mode === "regen-all" ? "Regenerate all" :
                    mode === "remaining" ? `Generate remaining ${remainingCount} beat${remainingCount === 1 ? "" : "s"}` :
                    mode === "fresh" ? `Generate ${remainingCount} beat${remainingCount === 1 ? "" : "s"}` :
                    /* stale-regen */ `Regenerate ${staleCount} beat${staleCount === 1 ? "" : "s"}`;
                  const titleText =
                    mode === "regen-all" ? `Re-runs TTS for all ${totalBeats} beats — overwrites every existing voiceover` :
                    mode === "remaining" ? `Generates ${remainingCount} beat${remainingCount === 1 ? "" : "s"} that don't have audio yet; ${doneCount} already-done beat${doneCount === 1 ? "" : "s"} kept` :
                    mode === "fresh" ? `Generates ${remainingCount} beat${remainingCount === 1 ? "" : "s"}` :
                    `Re-runs TTS for ${staleCount} beat${staleCount === 1 ? "" : "s"} where the voice or script changed since generation`;
                  return (
                    <button
                      onClick={mode === "regen-all" ? openRegenConfirm : () => runGeneration()}
                      disabled={!totalBeats || !selectedVoice}
                      title={titleText}
                      className="px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 transition-all"
                      style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                    >
                      {label}
                    </button>
                  );
                })()}
              </div>
            </div>
            {generating && progress && progress.total > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-[11px]" style={{ color: "var(--c-45)" }}>
                  <span className="font-mono tabular-nums">{progress.current}/{progress.total}</span>
                  <span>completed</span>
                </div>
                <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--bg-progress)" }}>
                  <div className="h-full rounded-full transition-all duration-200"
                    style={{ width: `${Math.round((progress.current / progress.total) * 100)}%`, background: "oklch(0.55 0.15 145)" }} />
                </div>
              </div>
            )}
          </div>

          {/* Per-beat cards — 2-column grid on sm+ screens */}
          {beats.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {beats.map((b) => {
                const status = effectiveStatus(b);
                const url = effectiveUrl(b);
                const err = effectiveError(b);
                // Card style varies by state so the user can see at a
                // glance which beats are already on file (subtle green
                // accent) vs which need work (default panel for pending
                // / queued, red accent for failed).
                const cardStyle =
                  status === "done"
                    ? { background: "oklch(0.55 0.15 145 / 0.06)", border: "1px solid oklch(0.55 0.15 145 / 0.25)" }
                    : status === "failed"
                      ? { background: "oklch(0.6 0.22 25 / 0.06)", border: "1px solid oklch(0.6 0.22 25 / 0.3)" }
                      : { background: "var(--bg-panel)", border: "1px solid var(--bd-7)" };
                return (
                  <div
                    key={b.beatNumber}
                    className="rounded-xl p-4 flex items-start gap-3"
                    style={cardStyle}
                  >
                    <span
                      className="font-mono text-xs font-semibold tabular-nums shrink-0 w-7"
                      style={{ color: "var(--c-45)" }}
                    >
                      {b.beatNumber}
                    </span>
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <p
                        className="text-xs leading-relaxed line-clamp-3"
                        style={{ color: "var(--c-60)" }}
                      >
                        {b.scriptSegment}
                      </p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <StatusPill status={status} />
                      </div>
                      {status === "done" && url && (
                        <audio controls src={url} className="h-7 w-full" preload="none" />
                      )}
                      {status === "failed" && err && (
                        <span
                          className="text-[10px] block"
                          style={{ color: "oklch(0.7 0.2 25)" }}
                          title={err}
                        >
                          {err.length > 80 ? err.slice(0, 80) + "…" : err}
                        </span>
                      )}
                    </div>
                    {(() => {
                      const isPerBeatRegen = perBeatRegen?.beatNumber === b.beatNumber;
                      // Per-beat regen state takes priority on this
                      // row — show Stop while running, Resume after
                      // the user stopped it.
                      if (isPerBeatRegen && perBeatRegen?.status === "running") {
                        return (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span
                              className="w-7 h-7 rounded-lg flex items-center justify-center"
                              aria-label="Beat regenerating"
                              title="Regenerating"
                              style={{ background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.3)", color: "oklch(0.72 0.25 285)" }}
                            >
                              <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                            </span>
                            <button
                              onClick={stopPerBeatRegen}
                              aria-label="Stop regenerating this beat"
                              title="Stop"
                              className="w-7 h-7 rounded-lg flex items-center justify-center text-[11px] font-medium transition-opacity hover:opacity-90"
                              style={{ background: "oklch(0.6 0.22 25)", color: "var(--bg-page-2)" }}
                            >
                              <span className="w-3 h-3 rounded-sm" style={{ background: "currentColor" }} />
                            </button>
                          </div>
                        );
                      }
                      if (isPerBeatRegen && perBeatRegen?.status === "stopped") {
                        return (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              onClick={resumePerBeatRegen}
                              aria-label="Resume regenerating this beat"
                              title="Resume"
                              className="px-2.5 py-1 rounded-lg text-[11px] font-medium transition-opacity hover:opacity-90"
                              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                            >
                              Resume
                            </button>
                            <button
                              onClick={() => setPerBeatRegen(null)}
                              aria-label="Dismiss"
                              title="Dismiss"
                              className="w-7 h-7 rounded-lg flex items-center justify-center text-[11px] font-medium transition-opacity hover:opacity-90"
                              style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-7)", color: "var(--c-55)" }}
                            >
                              ×
                            </button>
                          </div>
                        );
                      }
                      // No per-beat regen for this row. Render either
                      // a spinner (bulk run actively encoding this beat)
                      // or a static dot (beat is waiting in the queue,
                      // worker pool hasn't picked it up yet). Pre-worker-
                      // pool, "queued" was a transient state for ~5
                      // rows at a time, so a spinner read fine; now the
                      // queue can span hundreds of rows and a spinner
                      // on every one would falsely suggest 100+ beats
                      // are in flight simultaneously.
                      if (status === "generating") {
                        return (
                          <div
                            className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                            aria-label="Beat regenerating"
                            title="Regenerating"
                            style={{ background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.3)", color: "oklch(0.72 0.25 285)" }}
                          >
                            <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                          </div>
                        );
                      }
                      if (status === "queued") {
                        return (
                          <div
                            className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                            aria-label="Beat queued"
                            title="Queued"
                            style={{ background: "oklch(0.72 0.16 70 / 0.10)", border: "1px solid oklch(0.72 0.16 70 / 0.28)", color: "oklch(0.85 0.12 70)" }}
                          >
                            <span className="w-2 h-2 rounded-full" style={{ background: "currentColor", opacity: 0.75 }} />
                          </div>
                        );
                      }
                      if ((status === "failed" || status === "done") && !generating) {
                        return (
                          <button
                            onClick={() => retryOne(b.beatNumber, status)}
                            aria-label={status === "failed" ? "Retry beat" : "Regenerate beat"}
                            title={status === "failed" ? "Retry" : "Regenerate"}
                            className={`${status === "failed" ? "px-2.5" : "px-1.5"} py-1 rounded-lg text-[11px] font-medium flex items-center justify-center transition-opacity hover:opacity-90 shrink-0`}
                            style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-7)", color: "var(--c-55)" }}
                          >
                            {status === "failed" ? "Retry" : <RotateCw className="w-3.5 h-3.5" />}
                          </button>
                        );
                      }
                      return null;
                    })()}
                  </div>
                );
              })}
            </div>
          )}

          {/* Full voiceover preview — sits below the beat grid so the
              user reviews each beat individually first, then hears the
              whole narration end-to-end. Renders as soon as ANY beat
              has audio (live overlay or persisted) so the user can
              start listening before the full run finishes. */}
          {(beats.some((b) => !!b.voiceoverUrl)
            || Array.from(liveBeats.values()).some((s) => s.status === "done" && !!s.url)) && (
            <FullVoiceoverPreview projectId={projectId} beats={beats} liveBeats={liveBeats} />
          )}
          </>
          )}
        </div>
        </div>
      </main>

      {/* Continue bar — shows as soon as at least one beat has audio
          so the user can advance without waiting for the whole batch.
          Wording softens to "Continue with N of M" until allDone, then
          becomes the plain "Continue →" once everything's ready. */}
      {doneCount > 0 && (
        <div
          className="fixed bottom-0 left-0 md:left-64 right-0 z-20 py-3"
          style={{ background: "var(--bg-header-2)", borderTop: "1px solid var(--bd-6)", backdropFilter: "blur(12px)" }}
        >
          <div className="sm:px-8">
            <button
              onClick={() => router.push(`/projects/${projectId}/generate`)}
              className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
            >
              {allDone ? "Continue →" : `Continue with ${doneCount} of ${totalBeats} beats →`}
            </button>
          </div>
        </div>
      )}

      {/* Confirm dialog — driven by the `confirm` state. Both the Clear
          and Regenerate-all flows reuse this same shell, just with
          different copy, icon, and confirm-button color. */}
      {confirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "oklch(0 0 0 / 0.6)", backdropFilter: "blur(4px)" }}
          onClick={() => setConfirm(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl p-6 space-y-4"
            style={{ background: "var(--bg-card)", border: "1px solid var(--bd-7)" }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-modal-title"
          >
            <div className="flex items-start gap-3">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                style={{ background: confirm.iconBg, border: `1px solid ${confirm.iconBorder}` }}
              >
                <span style={{ color: confirm.iconColor, fontSize: "20px", lineHeight: 1 }}>{confirm.icon}</span>
              </div>
              <div className="flex-1 min-w-0">
                <h2 id="confirm-modal-title" className="text-base font-bold" style={{ color: "var(--c-90)" }}>
                  {confirm.title}
                </h2>
                <p className="text-sm mt-1" style={{ color: "var(--c-50)" }}>
                  {confirm.body}
                </p>
                {confirm.footnote && (
                  <p className="text-xs mt-2" style={{ color: "var(--c-45)" }}>
                    {confirm.footnote}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setConfirm(null)}
                className="px-4 py-2 rounded-lg text-sm font-medium transition-opacity hover:opacity-80"
                style={{ background: "transparent", color: "var(--c-60)", border: "1px solid var(--bd-7)" }}
              >
                Cancel
              </button>
              <button
                onClick={() => { void confirm.onConfirm(); }}
                autoFocus
                className="px-4 py-2 rounded-lg text-sm font-semibold transition-opacity hover:opacity-90"
                style={{ background: confirm.confirmBg, color: "var(--bg-page-2)" }}
              >
                {confirm.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
