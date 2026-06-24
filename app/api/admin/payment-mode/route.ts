import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";
import { getPaymentSettings } from "@/lib/plans";

// Global Dodo payment settings. Persisted on the singleton
// product_config._global row (same pattern as anthropic_routing,
// default_*_model, etc.). The `mode` field used to live here as an
// admin toggle; it's now derived from the deployment env (HECLUS_ENV)
// so local + staging never accidentally bill through the live SKU.
// The PATCH below silently ignores mode updates for backward compat
// — older clients can still POST it without breaking.

export const dynamic = "force-dynamic";

interface PaymentSettingsPatch {
  mode?: unknown;
  productionTestLink?: unknown;
  secretKeyTest?: unknown;
  secretKeyProduction?: unknown;
  baseUrlTest?: unknown;
  baseUrlProduction?: unknown;
  webhookSecretTest?: unknown;
  webhookSecretProduction?: unknown;
}

// Normalize an arbitrary string-or-null patch value into the form
// product_config wants. Empty / whitespace / null all clear the row;
// strings are trimmed. Anything else returns undefined which signals
// the caller to reject with a 400.
function normalizeNullableString(v: unknown): string | null | undefined {
  if (v === null || v === "") return null;
  if (typeof v === "string") return v.trim() || null;
  return undefined;
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

  // `mode` is no longer admin-tunable — getEffectivePaymentMode()
  // resolves it from HECLUS_ENV at runtime. Silently accept the
  // field for backward compat with existing clients; just don't
  // write it.

  if (body.productionTestLink !== undefined) {
    const normalized = normalizeNullableString(body.productionTestLink);
    if (normalized === undefined) {
      return NextResponse.json({ error: "productionTestLink must be string, null, or ''" }, { status: 400 });
    }
    update.dodo_production_test_link = normalized;
  }

  if (body.secretKeyTest !== undefined) {
    const normalized = normalizeNullableString(body.secretKeyTest);
    if (normalized === undefined) {
      return NextResponse.json({ error: "secretKeyTest must be string, null, or ''" }, { status: 400 });
    }
    update.dodo_secret_key_test = normalized;
  }

  if (body.secretKeyProduction !== undefined) {
    const normalized = normalizeNullableString(body.secretKeyProduction);
    if (normalized === undefined) {
      return NextResponse.json({ error: "secretKeyProduction must be string, null, or ''" }, { status: 400 });
    }
    update.dodo_secret_key_production = normalized;
  }

  if (body.baseUrlTest !== undefined) {
    const normalized = normalizeNullableString(body.baseUrlTest);
    if (normalized === undefined) {
      return NextResponse.json({ error: "baseUrlTest must be string, null, or ''" }, { status: 400 });
    }
    update.dodo_base_url_test = normalized;
  }

  if (body.baseUrlProduction !== undefined) {
    const normalized = normalizeNullableString(body.baseUrlProduction);
    if (normalized === undefined) {
      return NextResponse.json({ error: "baseUrlProduction must be string, null, or ''" }, { status: 400 });
    }
    update.dodo_base_url_production = normalized;
  }

  if (body.webhookSecretTest !== undefined) {
    const normalized = normalizeNullableString(body.webhookSecretTest);
    if (normalized === undefined) {
      return NextResponse.json({ error: "webhookSecretTest must be string, null, or ''" }, { status: 400 });
    }
    update.dodo_webhook_secret_test = normalized;
  }

  if (body.webhookSecretProduction !== undefined) {
    const normalized = normalizeNullableString(body.webhookSecretProduction);
    if (normalized === undefined) {
      return NextResponse.json({ error: "webhookSecretProduction must be string, null, or ''" }, { status: 400 });
    }
    update.dodo_webhook_secret_production = normalized;
  }

  if (Object.keys(update).length === 0) {
    console.warn("[payment-mode PATCH] no fields to update — body:", JSON.stringify(body));
    return NextResponse.json({ error: "no fields provided" }, { status: 400 });
  }

  console.log("[payment-mode PATCH] update payload:", JSON.stringify(update));

  // product_config has no unique constraint on `service` (table was
  // created outside migrations), so a Postgres upsert would raise
  // 42P10. Update-or-insert manually instead.
  const { data: existing, error: lookupErr } = await supabase
    .from("product_config")
    .select("service")
    .eq("service", "_global")
    .maybeSingle();
  if (lookupErr) {
    console.error("[payment-mode PATCH] lookup error:", lookupErr);
    return NextResponse.json({ error: lookupErr.message }, { status: 500 });
  }
  console.log("[payment-mode PATCH] existing row:", existing ? "found" : "missing");

  if (existing) {
    const { data: updated, error } = await supabase
      .from("product_config")
      .update(update)
      .eq("service", "_global")
      .select("service, dodo_secret_key_test, dodo_secret_key_production, dodo_base_url_test, dodo_base_url_production, dodo_webhook_secret_test, dodo_webhook_secret_production");
    if (error) {
      console.error("[payment-mode PATCH] update error:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    console.log(
      `[payment-mode PATCH] update succeeded rows=${updated?.length ?? 0} ` +
      `row=${JSON.stringify((updated?.[0] ?? null) && Object.fromEntries(Object.entries(updated![0]!).map(([k, v]) => [k, typeof v === "string" ? `${v.slice(0, 12)}…` : v])))}`,
    );
  } else {
    const { data: inserted, error } = await supabase
      .from("product_config")
      .insert({ service: "_global", ...update })
      .select("service");
    if (error) {
      console.error("[payment-mode PATCH] insert error:", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    console.log(`[payment-mode PATCH] insert succeeded rows=${inserted?.length ?? 0}`);
  }

  const settings = await getPaymentSettings();
  return NextResponse.json({ ok: true, ...settings });
}
