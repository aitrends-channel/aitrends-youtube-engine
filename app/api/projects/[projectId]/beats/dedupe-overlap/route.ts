import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { dedupeOverlap } from "@/lib/text/dedupeOverlap";
import type { User } from "@supabase/supabase-js";

// One-shot fixer for projects whose beats were generated before the
// non-overlap prompt rule landed in lib/claude/prompts.ts. Walks every
// beat in order, trims any leading overlap with the previous beat's
// text, and persists the cleaned script_segment back to project_beats.
//
// Does NOT touch voiceover_url — the audio still on file may carry
// the old overlap, but the hash mismatch (voiceover_script_hash was
// computed from the OLD text) will mark the row stale on next bulk
// Generate, prompting the user to regenerate audio for the affected
// beats. That's intentional: cleaning the text is non-destructive,
// regenerating audio is the user's choice.
export async function POST(_req: Request, { params }: { params: { projectId: string } }) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const projectId = params.projectId;

  // Ownership check — RLS would also block, but fail fast and return a
  // clean 404 instead of letting the update silently no-op.
  const { data: project, error: projErr } = await supabase
    .from("projects")
    .select("id, user_id")
    .eq("id", projectId)
    .eq("user_id", user.id)
    .single();
  if (projErr || !project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const { data: rawBeats, error: beatsErr } = await supabase
    .from("project_beats")
    .select("beat_number, script_segment")
    .eq("project_id", projectId)
    .order("beat_number");
  if (beatsErr) {
    return NextResponse.json({ error: `Failed to load beats: ${beatsErr.message}` }, { status: 500 });
  }
  const beats = (rawBeats ?? []) as { beat_number: number; script_segment: string | null }[];
  if (!beats.length) {
    return NextResponse.json({ ok: true, fixed: 0, total: 0 });
  }

  // Walk in script order, dedupe each against the previous beat's
  // ORIGINAL (pre-dedupe) text. Using the original — not the just-fixed
  // version — keeps the overlap detection stable: an overlap exists in
  // the source data or it doesn't.
  const updates: { beat_number: number; new_text: string }[] = [];
  let previous: string | null = null;
  for (const b of beats) {
    const current = (b.script_segment ?? "").trim();
    const previousOriginal = previous;
    previous = current;
    if (!current) continue;
    const trimmed = dedupeOverlap(current, previousOriginal);
    if (trimmed !== current) {
      updates.push({ beat_number: b.beat_number, new_text: trimmed });
    }
  }

  if (updates.length === 0) {
    console.log(`[dedupe-overlap] project=${projectId} no overlaps detected (total=${beats.length})`);
    return NextResponse.json({ ok: true, fixed: 0, total: beats.length });
  }

  // Per-row UPDATE — supabase-js doesn't have a great bulk-update-by-key
  // path for varying values. The N is small (project beats, not
  // database-wide) so per-row is fine.
  for (const u of updates) {
    const { error } = await supabase
      .from("project_beats")
      .update({ script_segment: u.new_text })
      .eq("project_id", projectId)
      .eq("beat_number", u.beat_number);
    if (error) {
      return NextResponse.json(
        { error: `Beat ${u.beat_number} update failed: ${error.message}`, fixed: updates.indexOf(u) },
        { status: 500 },
      );
    }
  }

  console.log(`[dedupe-overlap] project=${projectId} fixed ${updates.length}/${beats.length} beats: ${updates.map((u) => u.beat_number).join(",")}`);
  return NextResponse.json({ ok: true, fixed: updates.length, total: beats.length });
}
