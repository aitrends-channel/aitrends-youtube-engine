import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";

export const dynamic = "force-dynamic";

interface PlanPatch {
  name?: unknown;
  price_display?: unknown;
  price_cents?: unknown;
  period_display?: unknown;
  limit_display?: unknown;
  features?: unknown;
  niches_per_month?: unknown;
  payment_link_test?: unknown;
  payment_link_production?: unknown;
  highlighted?: unknown;
  disabled?: unknown;
  is_founder?: unknown;
  sort_order?: unknown;
}

// Allow-list of updatable columns. slug is intentionally not here:
// it's the user.app_metadata.plan key, so renaming would orphan paid
// users. Adding/removing slugs is POST + DELETE on the collection.
type UpdatableCol =
  | "name"
  | "price_display"
  | "price_cents"
  | "period_display"
  | "limit_display"
  | "features"
  | "niches_per_month"
  | "payment_link_test"
  | "payment_link_production"
  | "highlighted"
  | "disabled"
  | "is_founder"
  | "sort_order";

function coerce(col: UpdatableCol, raw: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  switch (col) {
    case "name":
    case "price_display":
    case "period_display":
    case "limit_display":
      if (typeof raw !== "string") return { ok: false, error: `${col} must be string` };
      return { ok: true, value: raw };
    case "features":
      if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string")) {
        return { ok: false, error: "features must be string[]" };
      }
      return { ok: true, value: raw };
    case "niches_per_month":
      if (raw === null) return { ok: true, value: null };
      if (typeof raw !== "number" || !Number.isInteger(raw)) {
        return { ok: false, error: "niches_per_month must be integer or null" };
      }
      return { ok: true, value: raw };
    case "price_cents":
      if (raw === null) return { ok: true, value: null };
      if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
        return { ok: false, error: "price_cents must be non-negative integer or null" };
      }
      return { ok: true, value: raw };
    case "payment_link_test":
    case "payment_link_production":
      if (raw === null) return { ok: true, value: null };
      if (typeof raw !== "string") return { ok: false, error: `${col} must be string or null` };
      return { ok: true, value: raw };
    case "highlighted":
    case "disabled":
    case "is_founder":
      if (typeof raw !== "boolean") return { ok: false, error: `${col} must be boolean` };
      return { ok: true, value: raw };
    case "sort_order":
      if (typeof raw !== "number" || !Number.isInteger(raw)) {
        return { ok: false, error: "sort_order must be integer" };
      }
      return { ok: true, value: raw };
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { slug } = await ctx.params;
  const normSlug = slug.toLowerCase().trim();
  if (!normSlug) return NextResponse.json({ error: "slug required" }, { status: 400 });

  let body: PlanPatch;
  try { body = (await req.json()) as PlanPatch; }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const update: Record<string, unknown> = {};
  const cols: UpdatableCol[] = [
    "name", "price_display", "price_cents", "period_display", "limit_display",
    "features", "niches_per_month",
    "payment_link_test", "payment_link_production",
    "highlighted", "disabled", "is_founder", "sort_order",
  ];
  for (const col of cols) {
    const raw = (body as Record<string, unknown>)[col];
    if (raw === undefined) continue;
    const result = coerce(col, raw);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    update[col] = result.value;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "no updatable fields provided" }, { status: 400 });
  }

  const { error } = await supabase.from("plans").update(update).eq("slug", normSlug);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { slug } = await ctx.params;
  const normSlug = slug.toLowerCase().trim();
  if (!normSlug) return NextResponse.json({ error: "slug required" }, { status: 400 });

  const { error } = await supabase.from("plans").delete().eq("slug", normSlug);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
