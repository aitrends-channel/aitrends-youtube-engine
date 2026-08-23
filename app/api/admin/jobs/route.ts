import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-server";
import { supabase } from "@/lib/supabase/client";

export const dynamic = "force-dynamic";

// Every piece of provider work the product has in flight, in one list.
//
// Until now "why is this beat stuck" meant three queries and a guess: the beat
// row says queued, the provider says nothing, and whether a hold is sitting
// against it lived in a third table. This joins the three things that answer
// the question: what state the beat is in, whether a provider task id exists
// for it, and whether credits are held against it.
//
// project_beats carries no timestamps, so age comes from the hold when there is
// one and from the project's updated_at otherwise. That is why a job with no
// hold shows a project age rather than its own: it is the best this schema can
// say, and saying it plainly beats inventing a number.

export type JobKind = "image" | "video" | "voiceover";

export interface AdminJob {
  kind: JobKind;
  projectId: string;
  projectName: string | null;
  userId: string;
  email: string | null;
  beatNumber: number;
  status: string;
  /** The provider's own id for the task, when one was recorded. */
  taskId: string | null;
  model: string | null;
  operator: string | null;
  error: string | null;
  /** Credits held against this beat, if a hold is still open. */
  heldCredits: number | null;
  /** When the hold was taken, or the project last moved. */
  since: string | null;
  /** True when the beat is waiting on a provider rather than finished. */
  inFlight: boolean;
}

const IMAGE_IN_FLIGHT = ["queued", "generating"];
const VIDEO_IN_FLIGHT = ["queued", "submitting", "rendering"];
const VOICE_IN_FLIGHT = ["queued", "generating"];

export async function GET(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  // "flight" is the default because it is the question this page exists to
  // answer. "failed" is for the morning after, and "all" for when neither
  // filter is telling the truth.
  const filter = url.searchParams.get("filter") ?? "flight";
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 200)));

  const [beatsRes, holdsRes] = await Promise.all([
    supabase
      .from("project_beats")
      .select(`
        project_id, beat_number,
        image_status, image_task_id, image_model_id, image_operator,
        video_status, video_job_id, video_model_id, video_error,
        voiceover_status, voiceover_job_id, voiceover_error,
        projects!inner(user_id, channel_name, video_model_id, updated_at)
      `)
      .limit(4000),
    supabase
      .from("credit_reservations")
      .select("user_id, project_id, beat_number, credits, provider, created_at")
      .eq("state", "open")
      .limit(2000),
  ]);

  if (beatsRes.error) {
    return NextResponse.json({ error: beatsRes.error.message }, { status: 500 });
  }

  const holds = new Map<string, { credits: number; created_at: string; provider: string | null }>();
  for (const h of (holdsRes.data ?? []) as Array<{
    project_id: string | null; beat_number: number | null; credits: number | string;
    created_at: string; provider: string | null;
  }>) {
    if (!h.project_id || h.beat_number === null) continue;
    holds.set(`${h.project_id}:${h.beat_number}`, {
      credits: Number(h.credits),
      created_at: h.created_at,
      provider: h.provider,
    });
  }

  const jobs: AdminJob[] = [];

  for (const row of (beatsRes.data ?? []) as Array<Record<string, unknown>>) {
    const proj = (Array.isArray(row.projects) ? row.projects[0] : row.projects) as {
      user_id: string; channel_name: string | null; video_model_id: string | null; updated_at: string;
    } | null;
    if (!proj) continue;

    const projectId = String(row.project_id);
    const beatNumber = Number(row.beat_number);
    const hold = holds.get(`${projectId}:${beatNumber}`);

    const base = {
      projectId,
      projectName: proj.channel_name,
      userId: proj.user_id,
      email: null as string | null,
      beatNumber,
      heldCredits: hold ? hold.credits : null,
      since: hold?.created_at ?? proj.updated_at ?? null,
    };

    const candidates: Array<Omit<AdminJob, keyof typeof base> & Partial<AdminJob>> = [
      {
        kind: "image",
        status: String(row.image_status ?? ""),
        taskId: (row.image_task_id as string | null) ?? null,
        model: (row.image_model_id as string | null) ?? null,
        operator: (row.image_operator as string | null) ?? null,
        error: null,
        inFlight: IMAGE_IN_FLIGHT.includes(String(row.image_status ?? "")),
      },
      {
        kind: "video",
        status: String(row.video_status ?? ""),
        taskId: (row.video_job_id as string | null) ?? null,
        model: (row.video_model_id as string | null) ?? proj.video_model_id ?? null,
        operator: null,
        error: (row.video_error as string | null) ?? null,
        inFlight: VIDEO_IN_FLIGHT.includes(String(row.video_status ?? "")),
      },
      {
        kind: "voiceover",
        status: String(row.voiceover_status ?? ""),
        taskId: (row.voiceover_job_id as string | null) ?? null,
        model: null,
        operator: null,
        error: (row.voiceover_error as string | null) ?? null,
        inFlight: VOICE_IN_FLIGHT.includes(String(row.voiceover_status ?? "")),
      },
    ];

    for (const c of candidates) {
      // A beat carries three lanes and most of them are idle. Only a lane with
      // a state worth reading becomes a row, or the list is three times the
      // length of the project for no information.
      const interesting = c.inFlight || c.status === "failed" || (hold && c.inFlight);
      if (!interesting) continue;
      if (filter === "flight" && !c.inFlight) continue;
      if (filter === "failed" && c.status !== "failed") continue;
      jobs.push({ ...base, ...c } as AdminJob);
    }
  }

  // In flight first, then the oldest, because an old in-flight job is the one
  // that is actually wrong.
  jobs.sort((a, b) => {
    if (a.inFlight !== b.inFlight) return a.inFlight ? -1 : 1;
    return String(a.since ?? "").localeCompare(String(b.since ?? ""));
  });

  const page = jobs.slice(0, limit);

  // Emails resolved for the page only. listUsers pages at 1,000 and this view
  // is read often enough that walking the whole directory per request would be
  // the slowest thing on the screen.
  const wanted = new Set(page.map((j) => j.userId));
  if (wanted.size > 0) {
    try {
      const { data } = await supabase.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const byId = new Map((data?.users ?? []).map((u) => [u.id, u.email ?? null]));
      for (const j of page) j.email = byId.get(j.userId) ?? null;
    } catch {
      // Ids are still identifying, just less readable.
    }
  }

  return NextResponse.json({
    jobs: page,
    total: jobs.length,
    inFlight: jobs.filter((j) => j.inFlight).length,
    failed: jobs.filter((j) => j.status === "failed").length,
    held: jobs.reduce((sum, j) => sum + (j.heldCredits ?? 0), 0),
  });
}
