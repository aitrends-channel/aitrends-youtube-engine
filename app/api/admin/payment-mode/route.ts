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
