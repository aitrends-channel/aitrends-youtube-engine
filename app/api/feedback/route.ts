import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

// GET  — has this user already responded? Presence of a user_feedback row
//         means yes (whether they submitted a rating or dismissed).
//         Also returns the stored fields so edit forms can prefill;
//         names fall back to auth metadata when the row has none yet.
// POST — record OR update a response (upsert keyed on user_id).
//         Body: { rating?: 1..5, feedbackText?: string, firstName?,
//         lastName? }. Omit rating to persist a bare dismissal.

export interface FeedbackStatus {
  hasResponded: boolean;
  rating: number | null;
  feedbackText: string | null;
  firstName: string | null;
  lastName: string | null;
}

// Names for prefill: stored row wins, then explicit first/last metadata
// (email signups), then a full_name split (OAuth signups).
function namesFromMetadata(user: User): { first: string | null; last: string | null } {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  const first = typeof meta.first_name === "string" ? meta.first_name.trim() : "";
  const last = typeof meta.last_name === "string" ? meta.last_name.trim() : "";
  if (first || last) return { first: first || null, last: last || null };
  const full = typeof meta.full_name === "string" ? meta.full_name.trim()
    : typeof meta.name === "string" ? meta.name.trim() : "";
  if (!full) return { first: null, last: null };
  const parts = full.split(/\s+/);
  return { first: parts[0] ?? null, last: parts.slice(1).join(" ") || null };
}

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { data } = await supabase
    .from("user_feedback")
    .select("user_id, rating, feedback_text, first_name, last_name")
    .eq("user_id", user.id)
    .maybeSingle();

  const fallback = namesFromMetadata(user);

  return NextResponse.json({
    hasResponded: !!data,
    rating: data?.rating ?? null,
    feedbackText: data?.feedback_text ?? null,
    firstName: data?.first_name ?? fallback.first,
    lastName: data?.last_name ?? fallback.last,
  } satisfies FeedbackStatus);
}

interface PostBody {
  rating?: number;
  feedbackText?: string;
  firstName?: string;
  lastName?: string;
}

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const body = (await req.json().catch(() => ({}))) as PostBody;

  const ratingRaw = body.rating;
  const rating = typeof ratingRaw === "number" && Number.isFinite(ratingRaw)
    ? Math.round(ratingRaw)
    : null;
  if (rating !== null && (rating < 1 || rating > 5)) {
    return NextResponse.json({ error: "rating must be between 1 and 5" }, { status: 400 });
  }

  const feedbackText = typeof body.feedbackText === "string" ? body.feedbackText.trim() : "";
  const bodyFirst = typeof body.firstName === "string" ? body.firstName.trim().slice(0, 100) : "";
  const bodyLast = typeof body.lastName === "string" ? body.lastName.trim().slice(0, 100) : "";
  const fallback = namesFromMetadata(user);
  const firstName = bodyFirst || fallback.first;
  const lastName = bodyLast || fallback.last;

  // Upsert so the same endpoint serves both the one-time modal (insert)
  // and the Account page's edit form (update). A bare-dismissal POST
  // arriving after a real rating would null it out, so guard: never
  // downgrade an existing rating to null.
  const { data: existing } = await supabase
    .from("user_feedback")
    .select("rating, feedback_text")
    .eq("user_id", user.id)
    .maybeSingle();

  if (existing && rating === null) {
    return NextResponse.json({ ok: true, alreadyResponded: true });
  }

  const { error } = await supabase.from("user_feedback").upsert({
    user_id: user.id,
    rating,
    feedback_text: feedbackText || null,
    first_name: firstName,
    last_name: lastName,
    ...(existing ? { updated_at: new Date().toISOString() } : {}),
  }, { onConflict: "user_id" });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
