import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";

export const dynamic = "force-dynamic";

export interface AdminFeedback {
  user_id: string;
  user_email: string | null;
  first_name: string | null;
  last_name: string | null;
  rating: number | null;
  feedback_text: string | null;
  created_at: string;
}

export interface AdminFeedbackResponse {
  reviews: AdminFeedback[];
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
      .from("user_feedback")
      .select("user_id, rating, feedback_text, first_name, last_name, created_at")
      .order("created_at", { ascending: false }),
    supabase.auth.admin.listUsers({ page: 1, perPage: 1000 }),
  ]);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const emailById = new Map((usersList?.users ?? []).map((u) => [u.id, u.email ?? null]));

  const reviews: AdminFeedback[] = (rows ?? []).map((r) => ({
    user_id: r.user_id,
    user_email: emailById.get(r.user_id) ?? null,
    first_name: r.first_name,
    last_name: r.last_name,
    rating: r.rating,
    feedback_text: r.feedback_text,
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
  } satisfies AdminFeedbackResponse);
}

// PATCH — admin edit of a user's feedback. Body: { userId, rating, feedbackText }.
// Service-role client bypasses RLS, so no extra policy is needed.
export async function PATCH(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const body = (await req.json().catch(() => ({}))) as {
    userId?: string;
    rating?: number;
    feedbackText?: string;
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

  const feedbackText = typeof body.feedbackText === "string" ? body.feedbackText.trim() : "";

  const { data, error } = await supabase
    .from("user_feedback")
    .update({
      rating,
      feedback_text: feedbackText || null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", body.userId)
    .select("user_id");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "Feedback not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}

// DELETE — remove a user's feedback entirely. Body: { userId }. Note this
// re-arms the one-time prompt for that user: row presence is the "has
// responded" gate, so deleting the row means they'll be asked again on
// their next completed-pipeline signal.
export async function DELETE(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const body = (await req.json().catch(() => ({}))) as { userId?: string };
  if (!body.userId || typeof body.userId !== "string") {
    return NextResponse.json({ error: "userId is required" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("user_feedback")
    .delete()
    .eq("user_id", body.userId)
    .select("user_id");

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!data || data.length === 0) {
    return NextResponse.json({ error: "Feedback not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
