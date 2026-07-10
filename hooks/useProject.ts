"use client";

import useSWR from "swr";

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) return r.json().catch(() => ({})).then((e: { error?: string }) => { throw new Error(e.error ?? `Request failed (${r.status})`); });
    return r.json().catch(() => ({}));
  });

// Idle poll rate. Slow enough to keep Supabase's disk-IO budget happy;
// user-initiated actions (save, generate, continue) already call mutate()
// explicitly so this interval is only the safety net for worker- or
// other-tab-driven changes.
const IDLE_MS = 10_000;
// Active poll rate — used while the project has a server-side "in flight"
// run id set. Keeps worker completion (script finish, assembly finalize,
// video job status) feeling responsive without hammering the DB the rest
// of the time.
const ACTIVE_MS = 4_000;

// Any of these being non-null means a background job is running that the
// UI needs to see finish. Keep this list in sync with the *_active_run_id
// columns on projects. Video-beat rendering has its own 4s poller in
// generate/page.tsx so we don't duplicate that signal here.
const ACTIVE_RUN_ID_KEYS = [
  "script_active_run_id",
  "prompts_active_run_id",
  "voiceover_active_run_id",
] as const;

// Fast poll rate used while image/video beats are actively being produced
// by KIE. The completion path is push-based (KIE → our webhook → DB), so
// the DB row flips to done/failed the instant KIE settles; this cadence is
// purely the DB→UI hop — it keeps the UI no more than ~2s behind that write
// without polling KIE from the browser. Kept under 2s deliberately.
const GEN_MS = 1_500;

type BeatStatusFields = {
  imageStatus?: string | null;
  videoStatus?: string | null;
};

type ProjectFields = Partial<Record<(typeof ACTIVE_RUN_ID_KEYS)[number], unknown>> & {
  assembly_status?: string | null;
  assembly_finalize_preview_requested?: boolean | null;
  beats?: BeatStatusFields[] | null;
};

function hasActiveRun(project: ProjectFields | undefined): boolean {
  if (!project) return false;
  if (ACTIVE_RUN_ID_KEYS.some((k) => project[k] != null)) return true;
  // assembly_status is set for the entire duration of assembly and cleared
  // (or set to "done" / "stopped") when the worker settles.
  const status = project.assembly_status;
  if (status && status !== "done" && status !== "stopped") return true;
  if (project.assembly_finalize_preview_requested) return true;
  return false;
}

// True while any beat is still being produced (image generating, or video
// queued/submitting/rendering). Drives the fast GEN_MS poll so KIE
// completions — written to the DB by the webhook/worker — surface in the UI
// within ~2s. Terminal states (done/failed) are excluded so polling backs
// off the moment everything settles.
function hasActiveGeneration(project: ProjectFields | undefined): boolean {
  const beats = project?.beats;
  if (!Array.isArray(beats)) return false;
  return beats.some(
    (b) =>
      b.imageStatus === "generating" ||
      b.videoStatus === "queued" ||
      b.videoStatus === "submitting" ||
      b.videoStatus === "rendering"
  );
}

export function useProject(projectId: string | null) {
  const { data, error, isLoading, mutate } = useSWR(
    projectId ? `/api/projects/${projectId}` : null,
    fetcher,
    {
      // Hidden tabs stop polling entirely — SWR's default revalidateOnFocus
      // catches them up when the user returns.
      refreshWhenHidden: false,
      refreshInterval: (latest: ProjectFields | undefined) => {
        // Generation in flight → fast DB→UI reflect (~2s). Other
        // server-side runs (script/prompts/voiceover/assembly) → 4s.
        // Otherwise idle safety-net poll at 10s.
        if (hasActiveGeneration(latest)) return GEN_MS;
        if (hasActiveRun(latest)) return ACTIVE_MS;
        return IDLE_MS;
      },
    }
  );

  return {
    project: data,
    isLoading,
    isError: error,
    mutate,
  };
}
