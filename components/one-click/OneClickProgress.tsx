"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Loader2, Circle, AlertTriangle, Download, Pause, Play, Square } from "lucide-react";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// The steps in pipeline order, each with the current_state (and extra
// signal) that marks it complete. Keep in sync with the orchestrator's
// state machine.
const STEPS: { key: string; label: string; done: (p: ProjectState) => boolean; active: (p: ProjectState) => boolean }[] = [
  { key: "channel",  label: "Channel analysis", done: (p) => p.current_state > 5, active: (p) => p.current_state <= 5 },
  { key: "topic",    label: "Topic",            done: (p) => p.current_state > 6 || (p.current_state === 6 && !!p.selected_topic), active: (p) => p.current_state === 6 && !p.selected_topic },
  { key: "script",   label: "Script",           done: (p) => p.current_state >= 7, active: (p) => p.current_state === 6 && !!p.selected_topic },
  { key: "visuals",  label: "Visuals",          done: (p) => p.current_state >= 9, active: (p) => p.current_state >= 7 && p.current_state <= 8 },
  { key: "prompts",  label: "Prompts & voiceover", done: (p) => p.current_state >= 14, active: (p) => p.current_state >= 9 && p.current_state <= 13 },
  { key: "generate", label: "Images & video",   done: (p) => p.assembly_status === "done" || p.current_state >= 15, active: (p) => p.current_state === 14 },
  { key: "assemble", label: "Final video",      done: (p) => p.assembly_status === "done", active: (p) => p.current_state >= 15 && p.assembly_status !== "done" },
];

interface ProjectState {
  id: string;
  current_state: number;
  selected_topic: string | null;
  word_count: number | null;
  assembly_status: string | null;
  assembled_url: string | null;
  auto_pilot: boolean;
  auto_pilot_status: string | null;
  auto_pilot_error: string | null;
}

// Live "watch it run" view for a 1Click project. Polls the project
// state, self-nudges the orchestrator tick while open (so progress is
// quick on screen; the cron is the backstop when the user leaves), and
// renders the pipeline checklist with Pause/Stop.
export function OneClickProgress({ projectId }: { projectId: string }) {
  const router = useRouter();
  const { data, mutate } = useSWR<{ project: ProjectState }>(
    `/api/projects/${projectId}`,
    fetcher,
    { refreshInterval: 4000 },
  );
  const p = data?.project;
  const status = p?.auto_pilot_status ?? null;
  const running = status === "running" || status === null;
  const [acting, setActing] = useState(false);

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

  const complete = p.assembly_status === "done";
  const done = complete || status === "completed";
  const completedCount = STEPS.filter((s) => s.done(p)).length;
  const pct = Math.round((completedCount / STEPS.length) * 100);

  return (
    <div className="max-w-xl mx-auto px-5 py-10 sm:py-16">
      <div className="text-center mb-6">
        <div className="w-14 h-14 rounded-2xl flex items-center justify-center mx-auto mb-4"
          style={{ background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
          {done
            ? <Check size={26} style={{ color: "oklch(0.65 0.15 145)" }} />
            : status === "paused"
              ? <Pause size={22} style={{ color: "oklch(0.7 0.16 65)" }} />
              : <Loader2 size={24} className="animate-spin" style={{ color: "oklch(0.72 0.25 285)" }} />}
        </div>
        <h1 className="text-xl font-bold" style={{ color: "var(--c-90)" }}>
          {done ? "Your video is ready" : status === "needs_attention" ? "1Click needs your input" : status === "paused" ? "1Click paused" : "1Click is building your video"}
        </h1>
        <p className="text-sm mt-1.5" style={{ color: "var(--c-50)" }}>
          {done
            ? "1Click ran the whole pipeline for you."
            : "You can watch here or close the tab — we'll keep going and email you when it's done."}
        </p>
      </div>

      {/* Step-count + progress bar */}
      {!done && (
        <div className="mb-5">
          <div className="flex items-center justify-between text-xs mb-1.5" style={{ color: "var(--c-50)" }}>
            <span className="font-semibold">Step {Math.min(completedCount + 1, STEPS.length)} of {STEPS.length}</span>
            <span>{pct}%</span>
          </div>
          <div className="h-2 rounded-full overflow-hidden" style={{ background: "oklch(1 0 0 / 0.06)" }}>
            <div className="h-full rounded-full transition-all" style={{ width: `${pct}%`, background: "oklch(0.72 0.25 285)" }} />
          </div>
        </div>
      )}

      {/* Step checklist */}
      <ol className="rounded-2xl overflow-hidden" style={{ background: "oklch(1 0 0 / 0.03)", border: "1px solid var(--bd-7)" }}>
        {STEPS.map((s, i) => {
          const isDone = s.done(p);
          const isActive = !isDone && s.active(p) && running;
          const isAttention = !isDone && s.active(p) && status === "needs_attention";
          const detail = s.key === "topic" && p.selected_topic ? p.selected_topic
            : s.key === "script" && p.word_count ? `${p.word_count.toLocaleString()} words`
            : null;
          return (
            <li key={s.key} className="flex items-center gap-3 px-4 py-3"
              style={{ borderTop: i === 0 ? "none" : "1px solid var(--bd-6)" }}>
              <span className="shrink-0">
                {isDone ? <Check size={16} style={{ color: "oklch(0.65 0.15 145)" }} />
                  : isAttention ? <AlertTriangle size={16} style={{ color: "oklch(0.6 0.19 25)" }} />
                  : isActive ? <Loader2 size={16} className="animate-spin" style={{ color: "oklch(0.72 0.25 285)" }} />
                  : <Circle size={16} style={{ color: "var(--c-30)" }} />}
              </span>
              <span className="flex-1 text-sm font-medium"
                style={{ color: isDone ? "var(--c-80)" : isActive || isAttention ? "var(--c-90)" : "var(--c-45)" }}>
                {s.label}
              </span>
              {detail && <span className="text-xs truncate max-w-[45%]" style={{ color: "var(--c-45)" }}>{detail}</span>}
            </li>
          );
        })}
      </ol>

      {status === "needs_attention" && p.auto_pilot_error && (
        <p className="text-sm mt-4 px-4 py-3 rounded-xl"
          style={{ background: "oklch(0.6 0.19 25 / 0.08)", border: "1px solid oklch(0.6 0.19 25 / 0.25)", color: "oklch(0.55 0.19 25)" }}>
          {p.auto_pilot_error}
        </p>
      )}

      <div className="flex items-center justify-between gap-3 mt-6 flex-wrap">
        {done ? (
          <>
            <a
              href={`/projects/${projectId}/thumbnails`}
              className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
            >
              Open video →
            </a>
            {p.assembled_url && (
              <a href={p.assembled_url} download
                className="inline-flex items-center gap-1.5 text-sm font-medium"
                style={{ color: "oklch(0.65 0.15 145)" }}>
                <Download size={14} /> Download
              </a>
            )}
          </>
        ) : (
          <>
            {/* Pause/Resume — hidden while a step needs attention. */}
            {status !== "needs_attention" && (
              status === "paused"
                ? (
                  <button onClick={() => control("resume")} disabled={acting}
                    className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-semibold cursor-pointer disabled:opacity-40 transition-opacity hover:opacity-90"
                    style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.88 0.12 285)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}>
                    <Play size={14} /> Resume
                  </button>
                ) : (
                  <button onClick={() => control("pause")} disabled={acting}
                    className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-semibold cursor-pointer disabled:opacity-40 transition-opacity hover:opacity-90"
                    style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.88 0.12 285)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}>
                    <Pause size={14} /> Pause
                  </button>
                )
            )}

            {status === "needs_attention" && (
              <button
                onClick={() => router.push(`/projects/${projectId}/${p.selected_topic || p.current_state > 6 ? "topic" : "channel"}`)}
                className="px-4 py-2.5 rounded-xl text-sm font-semibold cursor-pointer"
                style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
              >
                Finish in the editor →
              </button>
            )}

            {/* Stop — always available while the run isn't done. */}
            <button onClick={() => control("stop")} disabled={acting}
              className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-semibold cursor-pointer disabled:opacity-40 transition-opacity hover:opacity-90 ml-auto"
              style={{ background: "transparent", color: "oklch(0.7 0.22 25)", border: "1px solid oklch(0.6 0.22 25 / 0.4)" }}>
              <Square size={13} /> Stop 1Click
            </button>
          </>
        )}
      </div>
    </div>
  );
}
