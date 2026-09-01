import { NextResponse } from "next/server";
import { entitlementTier } from "@/lib/plan-tier";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { getAllPlans } from "@/lib/plans";
import {
  QUOTA_EXCLUDED_PLAN_SLUG,
  coerceQuotaConfig,
  invalidateQuotaConfigCache,
  validateQuotaInput,
  type QuotaConfig,
} from "@/lib/quota-config";

export const dynamic = "force-dynamic";

// Free/perk quota allocation per plan — powers Config → Quotas.
// Read is open to any authenticated user (matching /api/admin/concurrency);
// writes are admin-only.
export async function GET() {
  try { await getRequiredUser(); } catch (e) { return e as Response; }

  const { data, error } = await supabase
    .from("product_config")
    .select("free_quotas")
    .eq("service", "_global")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Plan slugs come from the plans table so the UI renders a column per
  // real plan rather than a hardcoded starter/pro pair. production-test
  // is excluded — it's the live-checkout verification harness, not a
  // customer tier, and no quota math runs against it.
  // The tier as well as the slug: the config is keyed by entitlement, so a
  // column for heclus_pro has to read and write the "pro" map. Sending only the
  // slug is what made every cell render 0.
  type Col = { slug: string; tier: string; name: string; isFounder: boolean };
  let plans: Col[] = [];
  let legacyPlans: Col[] = [];
  try {
    const all = (await getAllPlans()).filter((p) => p.slug !== QUOTA_EXCLUDED_PLAN_SLUG);
    const col = (p: (typeof all)[number]): Col =>
      ({ slug: p.slug, tier: entitlementTier(p.slug), name: p.name, isFounder: p.isFounder });
    plans = all.filter((p) => !p.legacy).map(col);
    // Retired products get their own tab. Founder in particular has never been
    // editable here: it is the only tier no plan on sale maps to, so it fell off
    // the page entirely when the Heclus products replaced the legacy ones.
    legacyPlans = all.filter((p) => p.legacy).map(col);
  } catch {
    plans = [];
    legacyPlans = [];
  }

  const config: QuotaConfig = coerceQuotaConfig((data as { free_quotas?: unknown } | null)?.free_quotas);
  return NextResponse.json({ config, plans, legacyPlans });
}

export async function PUT(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const body = await req.json().catch(() => ({}));

  // Merge the partial onto what's stored so saving one quota can't reset
  // the others.
  const { data: currentRow } = await supabase
    .from("product_config")
    .select("free_quotas")
    .eq("service", "_global")
    .single();
  const current = coerceQuotaConfig((currentRow as { free_quotas?: unknown } | null)?.free_quotas);
  const merged: Record<string, unknown> = { ...current, ...(body as object) };

  const parsed = validateQuotaInput(merged);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const { error } = await supabase
    .from("product_config")
    .update({ free_quotas: parsed.value })
    .eq("service", "_global");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  invalidateQuotaConfigCache();
  return NextResponse.json({ ok: true, value: parsed.value });
}
