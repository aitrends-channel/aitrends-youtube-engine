"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Loader2, Circle, AlertTriangle, Download, Pause, Play, Square, RotateCcw, Film, X, Clock } from "lucide-react";
import { IMAGE_MODELS } from "@/lib/kie/imageModels";
import { VIDEO_MODELS } from "@/lib/kie/videoModels";
import { OneClickControls } from "@/components/one-click/OneClickControls";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// id → friendly model name (e.g. "bytedance/seedance-2" → "Seedance 2").
const MODEL_NAMES: Record<string, string> = {};
for (const m of [...IMAGE_MODELS, ...VIDEO_MODELS]) MODEL_NAMES[m.id] = m.name;
function modelName(id?: string | null): string | null {
  return id ? (MODEL_NAMES[id] ?? id) : null;
}

interface BeatLite {
  imagePrompt?: string | null;
  videoPrompt?: string | null;
  imageUrl?: string | null;
  videoUrl?: string | null;
  voiceoverUrl?: string | null;
  imageModelId?: string | null;
  videoModelId?: string | null;
  imageStatus?: string | null;
  videoStatus?: string | null;
}
interface ThumbLite { imageUrl?: string | null }

interface ProjectState {
  id: string;
  current_state: number;
  selected_topic: string | null;
  word_count: number | null;
  assembly_status: string | null;
  assembly_progress: string | null;
  assembled_url: string | null;
  channel_name: string | null;
  /** Present from creation on a forked video (new video in an existing
   *  niche), which is how we know channel analysis isn't part of its run. */
  channel_analysis?: unknown;
  video_aspect_ratio: string | null;
  auto_pilot: boolean;
  auto_pilot_status: string | null;
  auto_pilot_error: string | null;
  auto_pilot_config?: { output?: { aspectRatio?: string } } | null;
  auto_pilot_started_at?: string | null;
  auto_pilot_completed_at?: string | null;
  beats?: BeatLite[];
  thumbnails?: ThumbLite[];
}

// Human "3m 12s" from a millisecond duration.
function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// Per-beat / per-thumbnail counts, derived from the beats + thumbnails
// the single-project GET returns. Drives the count + percentage each
// generation step shows while it runs.
interface Agg {
  total: number;
  imagePrompts: number;
  videoPrompts: number;
  voiceovers: number;
  images: number;
  videos: number;
  assembleReady: number;
  thumbsTotal: number;
  thumbs: number;
  imageModel: string | null;
  videoModel: string | null;
}
// The model currently in use for a media step: prefer a beat that's
// actively generating (that's the live model — it updates the moment the
// fallback chain steps to a new one), else the last beat that recorded a
// model. Returns the friendly name.
function currentModel(beats: BeatLite[], idKey: "imageModelId" | "videoModelId", statusKey: "imageStatus" | "videoStatus", active: string[]): string | null {
  const live = beats.find((b) => b[idKey] && active.includes(b[statusKey] ?? ""));
  if (live) return modelName(live[idKey]);
  for (let i = beats.length - 1; i >= 0; i--) if (beats[i][idKey]) return modelName(beats[i][idKey]);
  return null;
}
function aggregate(p: ProjectState): Agg {
  const beats = p.beats ?? [];
  const thumbs = p.thumbnails ?? [];
  const count = (pred: (b: BeatLite) => boolean) => beats.filter(pred).length;
  return {
    total: beats.length,
    imagePrompts: count((b) => !!b.imagePrompt?.trim()),
    videoPrompts: count((b) => !!b.videoPrompt?.trim()),
    voiceovers: count((b) => !!b.voiceoverUrl),
    images: count((b) => !!b.imageUrl),
    videos: count((b) => !!b.videoUrl),
    // Beats the assembler will actually use: per-beat mode needs BOTH a
    // visual and a voiceover; beats without either are dropped.
    assembleReady: count((b) => !!(b.imageUrl || b.videoUrl) && !!b.voiceoverUrl),
    thumbsTotal: thumbs.length,
    thumbs: thumbs.filter((t) => !!t.imageUrl).length,
    imageModel: currentModel(beats, "imageModelId", "imageStatus", ["generating", "queued"]),
    videoModel: currentModel(beats, "videoModelId", "videoStatus", ["queued", "submitting", "rendering"]),
  };
}

interface Count { done: number; total: number }
interface StepDef {
  key: string;
  label: string;
  done: (p: ProjectState, a: Agg) => boolean;
  count?: (a: Agg) => Count | null;
  detail?: (p: ProjectState, a: Agg) => string | null;
}

// Pipeline order. Channel + Topic render full-width up top; the rest sit
// in the 2-column grid below. Counted steps show N/total + a percentage.
// Keep this order in sync with the orchestrator's state machine.
const TOP_STEPS: StepDef[] = [
  { key: "channel", label: "Channel analysis", done: (p) => p.current_state > 5 },
  { key: "topic", label: "Topic", done: (p) => p.current_state > 6 || !!p.selected_topic, detail: (p) => p.selected_topic },
];
const GRID_STEPS: StepDef[] = [
  { key: "script", label: "Script", done: (p) => p.current_state >= 7, detail: (p) => (p.word_count ? `${p.word_count.toLocaleString()} words` : null) },
  { key: "visuals", label: "Visuals", done: (p) => p.current_state >= 9 },
  { key: "imagePrompts", label: "Image prompts", count: (a) => (a.total ? { done: a.imagePrompts, total: a.total } : null), done: (_p, a) => a.total > 0 && a.imagePrompts >= a.total },
  { key: "videoPrompts", label: "Video prompts", count: (a) => (a.total ? { done: a.videoPrompts, total: a.total } : null), done: (_p, a) => a.total > 0 && a.videoPrompts >= a.total },
  { key: "voiceovers", label: "Voiceovers", count: (a) => (a.total ? { done: a.voiceovers, total: a.total } : null), done: (_p, a) => a.total > 0 && a.voiceovers >= a.total },
  { key: "images", label: "Images", count: (a) => (a.total ? { done: a.images, total: a.total } : null), done: (_p, a) => a.total > 0 && a.images >= a.total, detail: (_p, a) => (a.imageModel ? `Model: ${a.imageModel}` : null) },
];
// Heavier final stages get their own full-width lane (one per row).
const LANE_STEPS: StepDef[] = [
  { key: "videos", label: "Videos", count: (a) => (a.total ? { done: a.videos, total: a.total } : null), done: (_p, a) => a.total > 0 && a.videos >= a.total, detail: (_p, a) => (a.videoModel ? `Model: ${a.videoModel}` : null) },
  { key: "assemble", label: "Assemble", count: (a) => (a.total ? { done: a.assembleReady, total: a.total } : null), done: (p) => p.assembly_status === "done" || p.current_state >= 16, detail: (p) => (p.assembly_status && p.assembly_status !== "done" ? (p.assembly_progress || "Assembling…") : null) },
  { key: "thumbnails", label: "Thumbnails", count: (a) => (a.thumbsTotal ? { done: a.thumbs, total: a.thumbsTotal } : null), done: (p) => p.current_state >= 16 || p.auto_pilot_status === "completed" },
];
const ALL_STEPS = [...TOP_STEPS, ...GRID_STEPS, ...LANE_STEPS];

type StepStatus = "done" | "active" | "attention" | "pending";

// Live "watch it run" view for a 1Click project. Polls the project
// state, self-nudges the orchestrator tick while open, and renders the
// pipeline as standalone steps with per-step counts + progress.
export function OneClickProgress({ projectId }: { projectId: string }) {
  const router = useRouter();
  // The single-project GET spreads the project fields at the top level
  // (not under a `project` key) and includes beats + thumbnails arrays.
  const { data, mutate } = useSWR<ProjectState & { error?: string }>(
    `/api/projects/${projectId}`,
    fetcher,
    { refreshInterval: 4000 },
  );
  const p = data && !data.error ? data : undefined;
  const status = p?.auto_pilot_status ?? null;
  const running = status === "running" || status === null;
  const [acting, setActing] = useState(false);
  const [busyStep, setBusyStep] = useState<string | null>(null);
  // null until the first project load — see STEPS below.
  const inheritedAnalysisRef = useRef<boolean | null>(null);

  // Live elapsed timer. Ticks every second while the run is active. Start
  // time is the DB stamp (auto_pilot_started_at); if that column isn't
  // present yet (migration 098 unapplied), fall back to when this view
  // first saw the run so a timer still shows.
  const [nowTs, setNowTs] = useState<number>(() => Date.now());
  const seenStartRef = useRef<number | null>(null);
  const timerRunning = (status === "running" || status === null) && !!p?.auto_pilot && !(p && p.current_state >= 16);
  useEffect(() => {
    if (p?.auto_pilot && seenStartRef.current === null) seenStartRef.current = Date.now();
  }, [p?.auto_pilot]);
  useEffect(() => {
    if (!timerRunning) return;
    setNowTs(Date.now());
    const id = setInterval(() => setNowTs(Date.now()), 1000);
    return () => clearInterval(id);
  }, [timerRunning]);

  // Manually (re)run a single step — click any grid step to generate it
  // or retry a failed one. The endpoint resets that step's incomplete
  // artifacts and re-enters the orchestrator there; the nudge runs it now.
  async function runStep(step: string, label: string) {
    if (busyStep) return;
    setBusyStep(step);
    try {
      const res = await fetch("/api/one-click/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, step }),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? `Request failed (${res.status})`);
      toast.success(`Re-running ${label}…`);
      void fetch("/api/one-click/tick", { method: "POST" }).catch(() => {});
      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusyStep(null);
    }
  }

  async function control(kind: "pause" | "resume" | "stop") {
    setActing(true);
    try {
      const res = kind === "stop"
        ? await fetch(`/api/one-click/start?projectId=${encodeURIComponent(projectId)}`, { method: "DELETE" })
        : await fetch("/api/one-click/start", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId, action: kind }),
          });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? `Request failed (${res.status})`);
      if (kind === "stop") {
        toast.success("1Click stopped — finish this video yourself anytime");
        router.push(`/projects/${projectId}/channel`);
        return;
      }
      toast.success(kind === "pause" ? "1Click paused" : "1Click resumed");
      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Request failed");
    } finally {
      setActing(false);
    }
  }

  // Drive the orchestrator while this page is open and the run is
  // active — one nudge every 12s, on top of the 2-min cron backstop.
  useEffect(() => {
    if (!p?.auto_pilot || !running) return;
    const nudge = () => { void fetch("/api/one-click/tick", { method: "POST" }).then(() => mutate()).catch(() => {}); };
    nudge();
    const id = setInterval(nudge, 12_000);
    return () => clearInterval(id);
  }, [p?.auto_pilot, running, mutate]);

  if (!p) {
    return (
      <div className="flex items-center justify-center py-20" style={{ color: "var(--c-45)" }}>
        <Loader2 size={20} className="animate-spin" />
      </div>
    );
  }

  // "Done" is only the true finish line — the orchestrator sets state 16
  // / status "completed" after the LAST thumbnail. Assembly finishing
  // isn't done: thumbnails still run after it.
  const done = status === "completed" || p.current_state >= 16;

  // Done → replace the whole live view with the final video preview.
  if (done && p.assembled_url) {
    const filename = `${(p.channel_name ?? "").trim() || "video"}.mp4`;
    // Follow the aspect ratio the run was configured/rendered at, exactly
    // like the assemble step: bound the preview width to 82vh × ratio so a
    // portrait video doesn't stretch full-width and the buttons line up
    // with the actual video edges.
    const ar = p.auto_pilot_config?.output?.aspectRatio || p.video_aspect_ratio || "16:9";
    const [arW, arH] = ar.split(":").map(Number);
    const previewMaxW = arW && arH ? `min(100%, calc(82vh * ${arW} / ${arH}))` : "100%";
    const startMs = p.auto_pilot_started_at ? Date.parse(p.auto_pilot_started_at) : NaN;
    const endMs = p.auto_pilot_completed_at ? Date.parse(p.auto_pilot_completed_at) : NaN;
    const durationMs = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs ? endMs - startMs : null;
    return (
      <div className="max-w-3xl mx-auto px-5 py-10 sm:py-16">
        <div className="text-center mb-6">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: "oklch(0.65 0.15 145 / 0.12)", border: "1px solid oklch(0.65 0.15 145 / 0.3)" }}>
            <Check size={26} style={{ color: "oklch(0.65 0.15 145)" }} />
          </div>
          <h1 className="text-xl font-bold" style={{ color: "var(--c-90)" }}>Your video is ready</h1>
          <p className="text-sm mt-1.5" style={{ color: "var(--c-50)" }}>1Click ran the whole pipeline for you.</p>
          {durationMs != null && (
            <p className="text-xs mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full"
              style={{ background: "oklch(1 0 0 / 0.05)", border: "1px solid var(--bd-7)", color: "var(--c-55)" }}>
              <Clock size={12} /> Generated in {formatDuration(durationMs)}
            </p>
          )}
        </div>

        <div className="mx-auto" style={{ maxWidth: previewMaxW }}>
          <video
            key={p.assembled_url}
            src={p.assembled_url}
            controls
            className="block w-full max-h-[82vh] rounded-xl"
            style={{ background: "var(--bg-page-2)", aspectRatio: arW && arH ? `${arW} / ${arH}` : undefined }}
          />

          <div className="grid grid-cols-2 gap-3 mt-5">
            <a
              href={`/api/projects/${projectId}/export-video?url=${encodeURIComponent(p.assembled_url)}&filename=${encodeURIComponent(filename)}`}
              className="inline-flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-semibold text-center transition-all"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
              <Download size={14} /> Export
            </a>
            <button
              onClick={() => router.push(`/projects/${projectId}/assemble`)}
              className="inline-flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-semibold cursor-pointer transition-all"
              style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "var(--accent-purple-text)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}>
              <Film size={14} /> View in studio
            </button>
            <button
              onClick={() => runStep("assemble", "Assemble")}
              disabled={!!busyStep}
              className="inline-flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-semibold cursor-pointer disabled:opacity-40 transition-all"
              style={{ background: "var(--bg-progress)", color: "var(--c-60)", border: "1px solid var(--bd-card)" }}>
              <RotateCcw size={14} /> Regenerate
            </button>
            <button
              onClick={() => router.push("/dashboard")}
              className="inline-flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-semibold cursor-pointer transition-all"
              style={{ background: "transparent", color: "var(--c-55)", border: "1px solid var(--bd-6)" }}>
              <X size={14} /> Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  const a = aggregate(p);
  // A new video in an existing niche starts at state 6 with the channel
  // analysis already copied across, so that step was never part of its run.
  // A brand-new niche starts below 6 with no analysis and does run it.
  // Captured on first load (same approach as seenStartRef) so a fresh
  // niche's pipeline doesn't renumber itself once its analysis lands.
  if (inheritedAnalysisRef.current === null) {
    inheritedAnalysisRef.current = Boolean(p.channel_analysis) && (p.current_state ?? 1) >= 6;
  }
  const STEPS = inheritedAnalysisRef.current ? ALL_STEPS.slice(1) : ALL_STEPS;
  const doneFlags = STEPS.map((s) => s.done(p, a));
  const firstActiveIdx = doneFlags.findIndex((d) => !d);
  const completedCount = doneFlags.filter(Boolean).length;
  const pct = Math.round((completedCount / STEPS.length) * 100);

  const statusOf = (idx: number): StepStatus => {
    if (doneFlags[idx]) return "done";
    if (idx === firstActiveIdx) return status === "needs_attention" ? "attention" : running ? "active" : "pending";
    return "pending";
  };

  return (
    <div className="max-w-2xl mx-auto px-5 py-10 sm:py-14">
      <div className="text-center mb-6">
        <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
          style={{ background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
          {status === "paused"
            ? <Pause size={22} style={{ color: "oklch(0.7 0.16 65)" }} />
            : status === "needs_attention"
              ? <AlertTriangle size={22} style={{ color: "oklch(0.6 0.19 25)" }} />
              : <Loader2 size={24} className="animate-spin" style={{ color: "var(--brand-text)" }} />}
        </div>
        <h1 className="text-xl font-bold" style={{ color: "var(--c-90)" }}>
          {status === "needs_attention" ? "1Click needs your input" : status === "paused" ? "1Click paused" : "1Click is building your video"}
        </h1>
        <p className="text-sm mt-1.5" style={{ color: "var(--c-50)" }}>
          Feel free to close this tab. We keep working and email you when your video is ready.
        </p>

        {/* Pause and Stop, on the page the run is actually watched from.
            These already existed but only on the dashboard card, so someone
            watching a run here had to navigate away to halt it — the one place
            it is most likely to be wanted. Same component, same endpoints; the
            status and error it needs are already in this panel's poll. */}
        <div className="flex justify-center mt-4">
          <OneClickControls
            projectId={projectId}
            status={status}
            error={p.auto_pilot_error ?? null}
            onChanged={() => void mutate()}
          />
        </div>
      </div>

      {/* Overall progress — with the live elapsed timer inline */}
      <div className="mb-5">
        <div className="flex items-center justify-between text-xs mb-1.5" style={{ color: "var(--c-50)" }}>
          <span className="font-semibold">Step {Math.min(completedCount + 1, STEPS.length)} of {STEPS.length}</span>
          <span className="flex items-center gap-2 tabular-nums">
            {(() => {
              const runStartTs = p.auto_pilot_started_at ? Date.parse(p.auto_pilot_started_at) : (seenStartRef.current ?? nowTs);
              const elapsedMs = Math.max(0, nowTs - runStartTs);
              return (
                <span className="inline-flex items-center gap-1" style={{ color: "var(--accent-purple-text)" }}>
                  <Clock size={11} /> {formatDuration(elapsedMs)}{status === "paused" ? " · paused" : ""}
                </span>
              );
            })()}
            <span>{pct}%</span>
          </span>
        </div>
        <div className="h-2 rounded-full overflow-hidden" style={{ background: "oklch(1 0 0 / 0.06)" }}>
          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: "oklch(0.72 0.25 285)" }} />
        </div>
      </div>

      {/* One step at a time, like the setup stepper — but this one advances
          itself: the 4s poll above moves firstActiveIdx on as the
          orchestrator completes each step, so there's nothing to click.
          Showing all eleven at once made the run read as a checklist the
          user was meant to work through. */}
      {(() => {
        // firstActiveIdx is -1 once everything is done; hold on the last
        // step so the view ends on "Thumbnails ✓" rather than going blank.
        const idx = firstActiveIdx === -1 ? STEPS.length - 1 : firstActiveIdx;
        const current = STEPS[idx];
        // Channel and Topic have no manual re-run endpoint; the rest do,
        // which is what makes a stuck step recoverable.
        const canRun = !TOP_STEPS.some((s) => s.key === current.key);
        return (
          <StepCard
            step={current}
            status={statusOf(idx)}
            agg={a}
            project={p}
            busy={busyStep === current.key}
            onRun={canRun ? () => runStep(current.key, current.label) : undefined}
          />
        );
      })()}

      {status === "needs_attention" && (
        <p className="text-sm mt-4 px-4 py-3 rounded-xl"
          style={{ background: "oklch(0.6 0.19 25 / 0.08)", border: "1px solid oklch(0.6 0.19 25 / 0.25)", color: "oklch(0.55 0.19 25)" }}>
          {p.auto_pilot_error || "This step couldn't be completed automatically. Retry it, finish it in the editor, or cancel 1Click."}
        </p>
      )}

      <div className="flex items-center justify-between gap-3 mt-6 flex-wrap">
        {status === "paused" ? (
          <>
            <button onClick={() => control("resume")} disabled={acting}
              className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-sm font-semibold cursor-pointer disabled:opacity-40 transition-opacity hover:opacity-90"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
              <Play size={14} /> Resume
            </button>
            <button onClick={() => control("stop")} disabled={acting}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-semibold cursor-pointer disabled:opacity-40 transition-opacity hover:opacity-90 ml-auto"
              style={{ background: "transparent", color: "oklch(0.7 0.22 25)", border: "1px solid oklch(0.6 0.22 25 / 0.4)" }}>
              <Square size={13} /> Cancel 1Click
            </button>
          </>
        ) : status === "needs_attention" ? (
          <>
            <button onClick={() => control("resume")} disabled={acting}
              className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-sm font-semibold cursor-pointer disabled:opacity-40 transition-opacity hover:opacity-90"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
              <RotateCcw size={14} /> Retry step
            </button>
            <button
              onClick={() => router.push(`/projects/${projectId}/${p.selected_topic || p.current_state > 6 ? "topic" : "channel"}`)}
              className="px-4 py-2.5 rounded-xl text-sm font-semibold cursor-pointer"
              style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "var(--accent-purple-text)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}
            >
              Finish in the editor →
            </button>
            <button onClick={() => control("stop")} disabled={acting}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-semibold cursor-pointer disabled:opacity-40 transition-opacity hover:opacity-90 ml-auto"
              style={{ background: "transparent", color: "oklch(0.7 0.22 25)", border: "1px solid oklch(0.6 0.22 25 / 0.4)" }}>
              <Square size={13} /> Cancel 1Click
            </button>
          </>
        ) : (
          <button onClick={() => control("pause")} disabled={acting}
            className="inline-flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-sm font-semibold cursor-pointer disabled:opacity-40 transition-opacity hover:opacity-90"
            style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "var(--accent-purple-text)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}>
            <Pause size={14} /> Pause
          </button>
        )}
      </div>
    </div>
  );
}

// One step tile. Shows an icon, label, optional detail, and — for
// counted steps — an N/total count, a percentage, and a mini progress
// bar while it's generating. Clickable (when onRun is passed) to
// generate/retry that specific step.
function StepCard({ step, status, agg, project, busy, onRun }: {
  step: StepDef; status: StepStatus; agg: Agg; project: ProjectState;
  busy?: boolean; onRun?: () => void;
}) {
  const count = step.count?.(agg) ?? null;
  const detail = step.detail?.(project, agg) ?? null;
  const cpct = count && count.total > 0 ? Math.round((count.done / count.total) * 100) : null;
  const clickable = !!onRun;

  // White border on every card (matches the 1Click config panel's section
  // wraps); status is conveyed by the background tint + the icon.
  const bg =
    status === "active" ? "oklch(0.72 0.25 285 / 0.08)"
    : status === "attention" ? "oklch(0.6 0.19 25 / 0.07)"
    : status === "done" ? "oklch(0.65 0.15 145 / 0.06)"
    : "oklch(1 0 0 / 0.05)";

  return (
    <div
      className={`rounded-2xl px-4 py-3.5 h-full transition-all ${clickable ? "cursor-pointer hover:brightness-125" : ""}`}
      style={{ background: bg, border: "1px solid oklch(1 0 0 / 0.4)", opacity: busy ? 0.6 : 1 }}
      role={clickable ? "button" : undefined}
      title={clickable ? `Click to generate or retry — ${step.label}` : undefined}
      onClick={clickable && !busy ? onRun : undefined}
    >
      <div className="flex items-center gap-2.5">
        <span className="shrink-0">
          {busy ? <Loader2 size={16} className="animate-spin" style={{ color: "var(--brand-text)" }} />
            : status === "done" ? <Check size={16} style={{ color: "oklch(0.65 0.15 145)" }} />
            : status === "attention" ? <AlertTriangle size={16} style={{ color: "oklch(0.6 0.19 25)" }} />
            : status === "active" ? <Loader2 size={16} className="animate-spin" style={{ color: "var(--brand-text)" }} />
            : <Circle size={16} style={{ color: "var(--c-30)" }} />}
        </span>
        <span className="flex-1 text-sm font-medium truncate"
          style={{ color: status === "done" ? "var(--c-80)" : status === "active" || status === "attention" ? "var(--c-90)" : "var(--c-45)" }}>
          {step.label}
        </span>
        {count && (
          <span className="text-xs font-semibold tabular-nums shrink-0"
            style={{ color: status === "done" ? "oklch(0.65 0.15 145)" : status === "active" ? "var(--accent-purple-text)" : "var(--c-45)" }}>
            {count.done}/{count.total}{cpct !== null ? ` · ${cpct}%` : ""}
          </span>
        )}
      </div>

      {/* Live count bar — always shown once totals are known, so numbers
          are visible during generation, not only after it finishes. */}
      {count && count.total > 0 && (
        <div className="h-1.5 rounded-full overflow-hidden mt-2.5" style={{ background: "oklch(1 0 0 / 0.06)" }}>
          <div className="h-full rounded-full transition-all"
            style={{ width: `${cpct}%`, background: status === "done" ? "oklch(0.65 0.15 145)" : "oklch(0.72 0.25 285)" }} />
        </div>
      )}

      {detail && (
        <p className="text-xs mt-1.5 truncate" style={{ color: "var(--c-45)" }}>{detail}</p>
      )}
    </div>
  );
}
