import { supabase } from "@/lib/supabase/client";

// Bulk-mail audience: owners of a project "stuck at" a given wizard
// phase — currently sitting at that step AND idle (projects.updated_at)
// for at least idleHours. "Idle" is reliable because a BEFORE UPDATE
// trigger stamps updated_at = now() on every write (migration 001).
//
// Phases are resolved to concrete predicates here (server-side) so the
// client only passes a phase id — the send route recomputes the audience
// from that id and never trusts a client recipient list.
//
// Real resting states: 1(channel) → 6(topic/script) → 7(visuals) →
// 9(prompts) → 14(voiceover→generate) → 15(assemble) → 16(done); 13 is
// the thumbnails side-branch. Two phase-pairs share a state and are
// split by a column signal:
//   • Topic vs Script  — both state 6, split by selected_topic.
//   • Voiceover vs Generate — both state 14, split by whether any beat
//     has audio_url yet (voiceover's output).
export const BULK_MAIL_MIN_IDLE_HOURS = 1;
export const BULK_MAIL_MAX_IDLE_HOURS = 24 * 365;
export const BULK_MAIL_DEFAULT_IDLE_HOURS = 24;
// current_state at/after this = finished (16 = thumbnails done, the last
// wizard node); anything below is an unfinished / in-progress video.
export const BULK_MAIL_FINAL_STATE = 16;

export const STUCK_PHASES = [
  { id: "channel",   label: "Channel setup" },
  { id: "topic",     label: "Topic" },
  { id: "script",    label: "Script" },
  { id: "visuals",   label: "Visuals" },
  { id: "prompts",   label: "Prompts" },
  { id: "voiceover",  label: "Voiceover" },
  { id: "generate",   label: "Generate" },
  { id: "assemble",   label: "Assemble" },
  { id: "thumbnails", label: "Thumbnails" },
] as const;

export type StuckPhaseId = (typeof STUCK_PHASES)[number]["id"];

// Full audience id: a concrete wizard phase, or "any" — owners of ANY
// unfinished video idle beyond the cutoff, regardless of step. "any"
// backs the second composer column.
export type BulkMailPhase = StuckPhaseId | "any";

const PHASE_IDS = new Set<string>(STUCK_PHASES.map((p) => p.id));
export function isStuckPhase(v: unknown): v is StuckPhaseId {
  return typeof v === "string" && PHASE_IDS.has(v);
}
export function isBulkMailPhase(v: unknown): v is BulkMailPhase {
  return v === "any" || isStuckPhase(v);
}

export function clampIdleHours(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return BULK_MAIL_DEFAULT_IDLE_HOURS;
  return Math.min(BULK_MAIL_MAX_IDLE_HOURS, Math.max(BULK_MAIL_MIN_IDLE_HOURS, Math.floor(n)));
}

export interface BulkMailRecipient {
  userId: string;
  email: string;
  /** First name for the {{name}} greeting token; "there" when unknown. */
  name: string;
  projectCount: number;
  furthestState: number;
  lastActivity: string;
}

// Best-effort first name for personalizing the greeting. Prefers the
// auth metadata name; falls back to "there" so "Hi {{name}}," still reads
// cleanly rather than injecting an email local-part.
function firstNameFor(user: { user_metadata?: Record<string, unknown> | null }): string {
  const meta = user.user_metadata ?? {};
  const raw = meta.full_name ?? meta.name ?? meta.first_name;
  if (typeof raw === "string" && raw.trim()) return raw.trim().split(/\s+/)[0];
  return "there";
}

// One matched project (video) for the admin preview table.
export interface BulkMailVideo {
  projectId: string;
  userId: string;
  ownerEmail: string;
  title: string;
  currentState: number;
  /** Exact step label for this row (phase label, or resolved per-row for "any"). */
  step: string;
  lastActivity: string;
}

export interface BulkMailAudience {
  recipients: BulkMailRecipient[];
  videos: BulkMailVideo[];
}

interface ProjectRow {
  id: string;
  user_id: string;
  current_state: number;
  updated_at: string;
  selected_topic: string | null;
  channel_name: string | null;
}

// Resolve the exact step for a row, disambiguating the shared-state pairs
// with the same signals the phase queries use (selected_topic for state
// 6; per-beat audio for state 14).
function resolveStep(p: ProjectRow, state14HasAudio: Set<string>): string {
  const n = p.current_state ?? 0;
  if (n <= 5) return "Channel setup";
  if (n === 6) return p.selected_topic?.trim() ? "Script" : "Topic";
  if (n === 7 || n === 8) return "Visuals";
  if (n >= 9 && n <= 12) return "Prompts";
  if (n === 13) return "Thumbnails";
  if (n === 14) return state14HasAudio.has(p.id) ? "Generate" : "Voiceover";
  if (n === 15) return "Assemble";
  return `Step ${n}`;
}

export async function getBulkMailAudience(
  phase: BulkMailPhase,
  idleHours: number = BULK_MAIL_DEFAULT_IDLE_HOURS,
): Promise<BulkMailAudience> {
  const hours = clampIdleHours(idleHours);
  const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();

  // Widen to `any`: supabase's fluent builder type instantiation blows
  // up (TS2589) when the same variable is reassigned across the switch
  // below. We re-narrow the result to ProjectRow[] after awaiting.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let query: any = supabase
    .from("projects")
    .select("id, user_id, current_state, updated_at, selected_topic, channel_name")
    .lt("updated_at", cutoff)
    .not("user_id", "is", null);

  // Stage predicate per phase (see resting-state map above). "any" takes
  // every unfinished video regardless of step.
  switch (phase) {
    case "any":
      query = query.lt("current_state", BULK_MAIL_FINAL_STATE);
      break;
    case "channel":
      query = query.lt("current_state", 6); // 1–5
      break;
    case "topic":
      query = query.eq("current_state", 6).is("selected_topic", null);
      break;
    case "script":
      query = query.eq("current_state", 6).not("selected_topic", "is", null);
      break;
    case "visuals":
      query = query.gt("current_state", 6).lt("current_state", 9); // 7–8
      break;
    case "prompts":
      query = query.gt("current_state", 8).lt("current_state", 13); // 9–12 (excl. 13 thumbnails)
      break;
    case "voiceover":
    case "generate":
      query = query.eq("current_state", 14);
      break;
    case "assemble":
      query = query.eq("current_state", 15);
      break;
    case "thumbnails":
      query = query.eq("current_state", 13); // thumbnails step (side-branch)
      break;
  }

  const { data, error } = await query.limit(10_000);
  if (error) throw new Error(`Failed to load projects: ${error.message}`);
  let projects = (data ?? []) as ProjectRow[];

  // Beat-audio signal for state-14 rows — splits the Voiceover/Generate
  // audiences (no audio → still on voiceover; some audio → moved on to
  // generate) and labels state-14 rows in "any" mode.
  let hasAudio = new Set<string>();
  const needsAudio = phase === "any" || phase === "voiceover" || phase === "generate";
  const s14 = needsAudio ? projects.filter((p) => p.current_state === 14).map((p) => p.id) : [];
  if (s14.length > 0) {
    const { data: beats, error: beatErr } = await supabase
      .from("project_beats")
      .select("project_id, audio_url")
      .in("project_id", s14)
      .not("audio_url", "is", null)
      .limit(50_000);
    if (beatErr) throw new Error(`Failed to load beats: ${beatErr.message}`);
    hasAudio = new Set((beats ?? []).map((b) => b.project_id as string));
  }
  if (phase === "voiceover") projects = projects.filter((p) => !hasAudio.has(p.id));
  if (phase === "generate") projects = projects.filter((p) => hasAudio.has(p.id));

  // Aggregate matching projects per owner.
  const byUser = new Map<string, { count: number; furthest: number; last: string }>();
  for (const p of projects) {
    const uid = p.user_id;
    const cur = p.current_state ?? 0;
    const upd = p.updated_at ?? cutoff;
    const e = byUser.get(uid);
    if (!e) byUser.set(uid, { count: 1, furthest: cur, last: upd });
    else {
      e.count += 1;
      if (cur > e.furthest) e.furthest = cur;
      if (upd > e.last) e.last = upd;
    }
  }
  if (byUser.size === 0) return { recipients: [], videos: [] };

  const { data: usersData, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) throw new Error(`listUsers failed: ${listErr.message}`);
  const idToUser = new Map(usersData.users.map((u) => [u.id, u]));
  const isTest = (uid: string) =>
    (idToUser.get(uid)?.app_metadata as { is_production_test?: boolean } | undefined)?.is_production_test === true;

  const recipients: BulkMailRecipient[] = [];
  for (const [uid, agg] of byUser) {
    const u = idToUser.get(uid);
    if (!u?.email) continue;
    if (isTest(uid)) continue;
    recipients.push({ userId: uid, email: u.email, name: firstNameFor(u), projectCount: agg.count, furthestState: agg.furthest, lastActivity: agg.last });
  }
  recipients.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));

  // Per-project rows for the preview table — same audience, but not
  // deduped by owner. Skip projects whose owner won't be mailed.
  const phaseLabel = phase === "any" ? "" : STUCK_PHASES.find((p) => p.id === phase)?.label ?? "";
  const videos: BulkMailVideo[] = [];
  for (const p of projects) {
    const u = idToUser.get(p.user_id);
    if (!u?.email || isTest(p.user_id)) continue;
    videos.push({
      projectId: p.id,
      userId: p.user_id,
      ownerEmail: u.email,
      title: (p.selected_topic?.trim() || p.channel_name?.trim() || "Untitled video"),
      currentState: p.current_state ?? 0,
      step: phase === "any" ? resolveStep(p, hasAudio) : phaseLabel,
      lastActivity: p.updated_at,
    });
  }
  // "any" mode is a cross-step overview → longest-stuck first; a single
  // phase reads better furthest-along first.
  if (phase === "any") videos.sort((a, b) => a.lastActivity.localeCompare(b.lastActivity));
  else videos.sort((a, b) => b.currentState - a.currentState);

  return { recipients, videos };
}
