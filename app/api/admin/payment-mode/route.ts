import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";
import { getPaymentSettings, type PaymentMode } from "@/lib/plans";

// Global Dodo payment settings. Persisted on the singleton
// product_config._global row (same pattern as anthropic_routing,
// default_*_model, etc.). Controls:
//   - mode: 'test' | 'production' — which URL plan.paymentLink resolves to
//   - productionTestLink: optional admin-only URL surfaced as a 4th
//     row on the Plans tab when mode='production'.

export const dynamic = "force-dynamic";

const VALID_MODES: PaymentMode[] = ["test", "production"];

function isPaymentMode(v: unknown): v is PaymentMode {
  return typeof v === "string" && (VALID_MODES as string[]).includes(v);
}

interface PaymentSettingsPatch {
  mode?: unknown;
  productionTestLink?: unknown;
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const settings = await getPaymentSettings();
  return NextResponse.json(settings);
}

export async function PATCH(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  let body: PaymentSettingsPatch;
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const update: Record<string, unknown> = {};

  if (body.mode !== undefined) {
    if (!isPaymentMode(body.mode)) {
      return NextResponse.json({ error: "mode must be 'test' or 'production'" }, { status: 400 });
    }
    update.dodo_payment_mode = body.mode;
  }

  if (body.productionTestLink !== undefined) {
    if (body.productionTestLink === null || body.productionTestLink === "") {
      update.dodo_production_test_link = null;
    } else if (typeof body.productionTestLink === "string") {
      update.dodo_production_test_link = body.productionTestLink.trim();
    } else {
      return NextResponse.json({ error: "productionTestLink must be string, null, or ''" }, { status: 400 });
    }
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "no fields provided" }, { status: 400 });
  }

  // product_config has no unique constraint on `service` (table was
  // created outside migrations), so a Postgres upsert would raise
  // 42P10. Update-or-insert manually instead.
  const { data: existing, error: lookupErr } = await supabase
    .from("product_config")
    .select("service")
    .eq("service", "_global")
    .maybeSingle();
  if (lookupErr) return NextResponse.json({ error: lookupErr.message }, { status: 500 });

  if (existing) {
    const { error } = await supabase
      .from("product_config")
      .update(update)
      .eq("service", "_global");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  } else {
    const { error } = await supabase
      .from("product_config")
      .insert({ service: "_global", ...update });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const settings = await getPaymentSettings();
  return NextResponse.json({ ok: true, ...settings });
}
