"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Loader2, Circle, AlertTriangle, Download, Pause, Play, Square, RotateCcw } from "lucide-react";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface BeatLite {
  imagePrompt?: string | null;
  videoPrompt?: string | null;
  imageUrl?: string | null;
  videoUrl?: string | null;
  voiceoverUrl?: string | null;
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
  auto_pilot: boolean;
  auto_pilot_status: string | null;
  auto_pilot_error: string | null;
  beats?: BeatLite[];
  thumbnails?: ThumbLite[];
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
  };
}

interface Count { done: number; total: number }
interface StepDef {
  key: string;
  label: string;
  done: (p: ProjectState, a: Agg) => boolean;
  count?: (a: Agg) => Count | null;
  detail?: (p: ProjectState) => string | null;
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
  { key: "images", label: "Images", count: (a) => (a.total ? { done: a.images, total: a.total } : null), done: (_p, a) => a.total > 0 && a.images >= a.total },
  { key: "videos", label: "Videos", count: (a) => (a.total ? { done: a.videos, total: a.total } : null), done: (_p, a) => a.total > 0 && a.videos >= a.total },
  { key: "assemble", label: "Assemble", count: (a) => (a.total ? { done: a.assembleReady, total: a.total } : null), done: (p) => p.assembly_status === "done" || p.current_state >= 16, detail: (p) => (p.assembly_status && p.assembly_status !== "done" ? (p.assembly_progress || "Assembling…") : null) },
  { key: "thumbnails", label: "Thumbnails", count: (a) => (a.thumbsTotal ? { done: a.thumbs, total: a.thumbsTotal } : null), done: (p) => p.current_state >= 16 || p.auto_pilot_status === "completed" },
];
const ALL_STEPS = [...TOP_STEPS, ...GRID_STEPS];

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
    return (
      <div className="max-w-xl mx-auto px-5 py-10 sm:py-16">
        <div className="text-center mb-6">
          <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
            style={{ background: "oklch(0.65 0.15 145 / 0.12)", border: "1px solid oklch(0.65 0.15 145 / 0.3)" }}>
            <Check size={26} style={{ color: "oklch(0.65 0.15 145)" }} />
          </div>
          <h1 className="text-xl font-bold" style={{ color: "var(--c-90)" }}>Your video is ready</h1>
          <p className="text-sm mt-1.5" style={{ color: "var(--c-50)" }}>1Click ran the whole pipeline for you.</p>
        </div>

        <video
          key={p.assembled_url}
          src={p.assembled_url}
          controls
          className="mx-auto block max-h-[70vh] rounded-xl w-full"
          style={{ background: "var(--bg-page-2)", maxWidth: "100%" }}
        />

        <div className="flex items-center gap-3 mt-5">
          <button
            onClick={() => router.push(`/projects/${projectId}/assemble`)}
            className="flex-1 inline-flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-semibold cursor-pointer transition-all"
            style={{ background: "var(--bg-progress)", color: "var(--c-60)", border: "1px solid var(--bd-card)" }}>
            <RotateCcw size={14} /> Regenerate
          </button>
          <a
            href={`/api/projects/${projectId}/export-video?url=${encodeURIComponent(p.assembled_url)}&filename=${encodeURIComponent(filename)}`}
            className="flex-1 inline-flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-sm font-semibold text-center transition-all"
            style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
            <Download size={14} /> Export
          </a>
        </div>
      </div>
    );
  }

  const a = aggregate(p);
  const doneFlags = ALL_STEPS.map((s) => s.done(p, a));
  const firstActiveIdx = doneFlags.findIndex((d) => !d);
  const completedCount = doneFlags.filter(Boolean).length;
  const pct = Math.round((completedCount / ALL_STEPS.length) * 100);

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
              : <Loader2 size={24} className="animate-spin" style={{ color: "oklch(0.72 0.25 285)" }} />}
        </div>
        <h1 className="text-xl font-bold" style={{ color: "var(--c-90)" }}>
          {status === "needs_attention" ? "1Click needs your input" : status === "paused" ? "1Click paused" : "1Click is building your video"}
        </h1>
        <p className="text-sm mt-1.5" style={{ color: "var(--c-50)" }}>
          You can watch here or close the tab — we&apos;ll keep going and email you when it&apos;s done.
        </p>
      </div>

      {/* Overall progress */}
      <div className="mb-5">
        <div className="flex items-center justify-between text-xs mb-1.5" style={{ color: "var(--c-50)" }}>
          <span className="font-semibold">Step {Math.min(completedCount + 1, ALL_STEPS.length)} of {ALL_STEPS.length}</span>
          <span>{pct}%</span>
        </div>
        <div className="h-2 rounded-full overflow-hidden" style={{ background: "oklch(1 0 0 / 0.06)" }}>
          <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: "oklch(0.72 0.25 285)" }} />
        </div>
      </div>

      {/* Channel + Topic full-width, then the rest in a 2-column grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {TOP_STEPS.map((s, i) => (
          <div key={s.key} className="sm:col-span-2">
            <StepCard step={s} status={statusOf(i)} agg={a} project={p} />
          </div>
        ))}
        {GRID_STEPS.map((s, gi) => (
          <StepCard key={s.key} step={s} status={statusOf(TOP_STEPS.length + gi)} agg={a} project={p}
            busy={busyStep === s.key}
            onRun={() => runStep(s.key, s.label)} />
        ))}
      </div>

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
              style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.88 0.12 285)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}
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
            style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.88 0.12 285)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}>
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
  const detail = step.detail?.(project) ?? null;
  const cpct = count && count.total > 0 ? Math.round((count.done / count.total) * 100) : null;
  const clickable = !!onRun;

  const border =
    status === "done" ? "oklch(0.65 0.15 145 / 0.3)"
    : status === "active" ? "oklch(0.72 0.25 285 / 0.35)"
    : status === "attention" ? "oklch(0.6 0.19 25 / 0.35)"
    : "var(--bd-7)";
  const bg =
    status === "active" ? "oklch(0.72 0.25 285 / 0.06)"
    : status === "attention" ? "oklch(0.6 0.19 25 / 0.05)"
    : "oklch(1 0 0 / 0.03)";

  return (
    <div
      className={`rounded-2xl px-4 py-3.5 h-full transition-all ${clickable ? "cursor-pointer hover:brightness-125" : ""}`}
      style={{ background: bg, border: `1px solid ${border}`, opacity: busy ? 0.6 : 1 }}
      role={clickable ? "button" : undefined}
      title={clickable ? `Click to generate or retry — ${step.label}` : undefined}
      onClick={clickable && !busy ? onRun : undefined}
    >
      <div className="flex items-center gap-2.5">
        <span className="shrink-0">
          {busy ? <Loader2 size={16} className="animate-spin" style={{ color: "oklch(0.72 0.25 285)" }} />
            : status === "done" ? <Check size={16} style={{ color: "oklch(0.65 0.15 145)" }} />
            : status === "attention" ? <AlertTriangle size={16} style={{ color: "oklch(0.6 0.19 25)" }} />
            : status === "active" ? <Loader2 size={16} className="animate-spin" style={{ color: "oklch(0.72 0.25 285)" }} />
            : <Circle size={16} style={{ color: "var(--c-30)" }} />}
        </span>
        <span className="flex-1 text-sm font-medium truncate"
          style={{ color: status === "done" ? "var(--c-80)" : status === "active" || status === "attention" ? "var(--c-90)" : "var(--c-45)" }}>
          {step.label}
        </span>
        {count && (
          <span className="text-xs font-semibold tabular-nums shrink-0"
            style={{ color: status === "done" ? "oklch(0.65 0.15 145)" : status === "active" ? "oklch(0.82 0.12 285)" : "var(--c-45)" }}>
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
