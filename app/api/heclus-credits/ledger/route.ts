import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/supabase/client";

export const dynamic = "force-dynamic";

// The full spend log for the Heclus Credits wallet.
//
// Separate from /api/heclus-credits, which serves the balance panel and its
// last few rows. This one is filtered and paged, because the question it answers
// is "what used my credits", and that is asked when the balance is low and the
// answer is somewhere in months of history.
//
// Deliberately not modelled on a provider console. A customer does not know what
// a task id is; they know which video they were making. So a row is keyed to the
// project and beat it came from, and the project is named rather than shown as a
// UUID.

const PAGE_SIZE = 25;
const KINDS = ["topup", "spend", "refund", "adjustment"] as const;

export interface LedgerEntry {
  id: string;
  kind: string;
  credits: number;
  note: string | null;
  provider: string | null;
  projectId: string | null;
  projectLabel: string | null;
  beatNumber: number | null;
  createdAt: string;
}

export interface LedgerPage {
  rows: LedgerEntry[];
  total: number;
  page: number;
  pageSize: number;
  /** Every provider that appears in this account's history, for the filter. */
  providers: string[];
}

export async function GET(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const url = new URL(req.url);
  const page = Math.max(0, Number(url.searchParams.get("page") ?? 0) || 0);
  const kind = url.searchParams.get("kind");
  const provider = url.searchParams.get("provider");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  let q = supabase
    .from("credit_ledger")
    .select("id, kind, credits, note, provider, project_id, beat_number, created_at", { count: "exact" })
    .eq("user_id", user.id);

  if (kind && (KINDS as readonly string[]).includes(kind)) q = q.eq("kind", kind);
  if (provider) q = q.eq("provider", provider);
  if (from) q = q.gte("created_at", from);
  // Inclusive of the end date the customer picked: they mean the whole day, and
  // a bare date parses as midnight, which would drop everything they did on it.
  if (to) q = q.lt("created_at", new Date(new Date(to).getTime() + 86400000).toISOString());

  const { data, count, error } = await q
    .order("created_at", { ascending: false })
    .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);

  if (error) {
    console.warn("[heclus-ledger] read failed:", error.message);
    return NextResponse.json({ error: "Could not read your activity." }, { status: 500 });
  }

  const raw = (data ?? []) as {
    id: string; kind: string; credits: number | string; note: string | null;
    provider: string | null; project_id: string | null; beat_number: number | null;
    created_at: string;
  }[];

  // Named in a second query rather than an embed: credit_ledger.project_id is a
  // plain UUID with no foreign key, so PostgREST has no relationship to follow.
  const projectIds = [...new Set(raw.map((r) => r.project_id).filter((v): v is string => !!v))];
  const labels = new Map<string, string>();
  if (projectIds.length > 0) {
    const { data: projects } = await supabase
      .from("projects")
      .select("id, selected_topic, channel_name")
      .in("id", projectIds)
      .eq("user_id", user.id);
    for (const p of (projects ?? []) as { id: string; selected_topic: string | null; channel_name: string | null }[]) {
      labels.set(p.id, p.selected_topic?.trim() || p.channel_name?.trim() || "Untitled project");
    }
  }

  // Read from the whole history, not the page, or the filter would offer only
  // what the current page happens to contain.
  const { data: providerRows } = await supabase
    .from("credit_ledger")
    .select("provider")
    .eq("user_id", user.id)
    .not("provider", "is", null);

  const body: LedgerPage = {
    rows: raw.map((r) => ({
      id: r.id,
      kind: r.kind,
      // NUMERIC arrives as a string over PostgREST, and a string sorts and
      // formats as text further up.
      credits: Number(r.credits),
      note: r.note,
      provider: r.provider,
      projectId: r.project_id,
      projectLabel: r.project_id ? labels.get(r.project_id) ?? null : null,
      beatNumber: r.beat_number,
      createdAt: r.created_at,
    })),
    total: count ?? 0,
    page,
    pageSize: PAGE_SIZE,
    providers: [...new Set(((providerRows ?? []) as { provider: string }[]).map((p) => p.provider))].sort(),
  };
  return NextResponse.json(body);
}
