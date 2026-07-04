import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

// GET  — has this user already responded? Presence of a user_reviews row
//         means yes (whether they submitted a rating or dismissed).
//         Also returns the stored rating/review_text so the Account
//         page can prefill its edit form.
// POST — record OR update a response (upsert keyed on user_id).
//         Body: { rating?: 1..5, reviewText?: string }. Omit both
//         fields to persist a bare dismissal.

export interface ReviewStatus {
  hasResponded: boolean;
  rating: number | null;
  reviewText: string | null;
}

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { data } = await supabase
    .from("user_reviews")
    .select("user_id, rating, review_text")
    .eq("user_id", user.id)
    .maybeSingle();

  return NextResponse.json({
    hasResponded: !!data,
    rating: data?.rating ?? null,
    reviewText: data?.review_text ?? null,
  } satisfies ReviewStatus);
}

interface PostBody {
  rating?: number;
  reviewText?: string;
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

  const reviewText = typeof body.reviewText === "string" ? body.reviewText.trim() : "";

  // Upsert so the same endpoint serves both the one-time modal (insert)
  // and the Account page's edit form (update). A bare-dismissal POST
  // arriving after a real rating would null it out, so guard: never
  // downgrade an existing rating to null.
  const { data: existing } = await supabase
    .from("user_reviews")
    .select("rating, review_text")
    .eq("user_id", user.id)
    .maybeSingle();

  if (existing && rating === null) {
    return NextResponse.json({ ok: true, alreadyResponded: true });
  }

  const { error } = await supabase.from("user_reviews").upsert({
    user_id: user.id,
    rating,
    review_text: reviewText || null,
    ...(existing ? { updated_at: new Date().toISOString() } : {}),
  }, { onConflict: "user_id" });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
