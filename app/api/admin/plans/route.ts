import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";
import { getPlans } from "@/lib/plans";

export const dynamic = "force-dynamic";

const SLUG_RE = /^[a-z][a-z0-9_-]{0,31}$/;

interface PlanPayload {
  slug?: unknown;
  name?: unknown;
  price_display?: unknown;
  period_display?: unknown;
  limit_display?: unknown;
  features?: unknown;
  niches_per_month?: unknown;
  payment_link?: unknown;
  highlighted?: unknown;
  disabled?: unknown;
  is_founder?: unknown;
  sort_order?: unknown;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function asNullableString(v: unknown): string | null | undefined {
  if (v === null) return null;
  if (typeof v === "string") return v;
  return undefined;
}
function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function asInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) ? v : undefined;
}
function asNullableInt(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v === "number" && Number.isInteger(v)) return v;
  return undefined;
}
function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  if (!v.every((x) => typeof x === "string")) return undefined;
  return v as string[];
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const plans = await getPlans();
  return NextResponse.json({ plans });
}

export async function POST(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: PlanPayload;
  try { body = (await req.json()) as PlanPayload; }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const slug = asString(body.slug)?.toLowerCase().trim();
  const name = asString(body.name)?.trim();
  const priceDisplay = asString(body.price_display)?.trim();

  if (!slug || !SLUG_RE.test(slug)) {
    return NextResponse.json({ error: "slug must match /^[a-z][a-z0-9_-]{0,31}$/" }, { status: 400 });
  }
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (!priceDisplay) return NextResponse.json({ error: "price_display required" }, { status: 400 });

  const features = asStringArray(body.features) ?? [];
  const nichesPerMonth = body.niches_per_month === undefined ? null : asNullableInt(body.niches_per_month);
  if (nichesPerMonth === undefined) {
    return NextResponse.json({ error: "niches_per_month must be integer or null" }, { status: 400 });
  }

  const insert = {
    slug,
    name,
    price_display: priceDisplay,
    period_display: asString(body.period_display) ?? "",
    limit_display: asString(body.limit_display) ?? "",
    features,
    niches_per_month: nichesPerMonth,
    payment_link: asNullableString(body.payment_link) ?? null,
    highlighted: asBool(body.highlighted) ?? false,
    disabled: asBool(body.disabled) ?? false,
    is_founder: asBool(body.is_founder) ?? false,
    sort_order: asInt(body.sort_order) ?? 0,
  };

  const { error } = await supabase.from("plans").insert(insert);
  if (error) {
    const status = error.code === "23505" ? 409 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }
  return NextResponse.json({ ok: true, slug });
}
