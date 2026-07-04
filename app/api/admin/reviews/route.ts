import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";

export const dynamic = "force-dynamic";

export interface AdminReview {
  user_id: string;
  user_email: string | null;
  rating: number | null;
  review_text: string | null;
  created_at: string;
}

export interface AdminReviewsResponse {
  reviews: AdminReview[];
  /** Average across rows that carry a rating (dismissals excluded). */
  averageRating: number | null;
  ratedCount: number;
  dismissedCount: number;
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const [{ data: rows, error }, { data: usersList }] = await Promise.all([
    supabase
      .from("user_reviews")
      .select("user_id, rating, review_text, created_at")
      .order("created_at", { ascending: false }),
    supabase.auth.admin.listUsers({ page: 1, perPage: 1000 }),
  ]);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const emailById = new Map((usersList?.users ?? []).map((u) => [u.id, u.email ?? null]));

  const reviews: AdminReview[] = (rows ?? []).map((r) => ({
    user_id: r.user_id,
    user_email: emailById.get(r.user_id) ?? null,
    rating: r.rating,
    review_text: r.review_text,
    created_at: r.created_at,
  }));

  const rated = reviews.filter((r) => r.rating !== null);
  const averageRating = rated.length
    ? Math.round((rated.reduce((s, r) => s + (r.rating ?? 0), 0) / rated.length) * 10) / 10
    : null;

  return NextResponse.json({
    reviews,
    averageRating,
    ratedCount: rated.length,
    dismissedCount: reviews.length - rated.length,
  } satisfies AdminReviewsResponse);
}

// PATCH — admin edit of a user's review. Body: { userId, rating, reviewText }.
// Service-role client bypasses RLS, so no extra policy is needed.
export async function PATCH(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const body = (await req.json().catch(() => ({}))) as {
    userId?: string;
    rating?: number;
    reviewText?: string;
  };

  if (!body.userId || typeof body.userId !== "string") {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  const rating = typeof body.rating === "number" && Number.isFinite(body.rating)
    ? Math.round(body.rating)
    : null;
  if (rating === null || rating < 1 || rating > 5) {
    return NextResponse.json({ error: "rating must be between 1 and 5" }, { status: 400 });
  }

  const reviewText = typeof body.reviewText === "string" ? body.reviewText.trim() : "";

  const { data, error } = await supabase
    .from("user_reviews")
    .update({
      rating,
      review_text: reviewText || null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", body.userId)
    .select("user_id");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "Review not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
