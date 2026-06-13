import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";
import type { User } from "@supabase/supabase-js";
import {
  CONCURRENCY_DEFAULTS,
  coerceConcurrencyConfig,
  invalidateConcurrencyConfigCache,
  validateConcurrencyInput,
  type ConcurrencyConfig,
} from "@/lib/concurrency-config";

export const dynamic = "force-dynamic";


export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const user = guard.user;

  const { data, error } = await supabase
    .from("product_config")
    .select("batched_processes")
    .eq("service", "_global")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Merge defaults in so the UI never has to deal with missing keys
  // (e.g. when a new knob is added and the DB row hasn't been migrated).
  const stored = (data?.batched_processes ?? {}) as Partial<ConcurrencyConfig>;
  const merged: ConcurrencyConfig = { ...CONCURRENCY_DEFAULTS, ...stored };
  return NextResponse.json(merged);
}

export async function PUT(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const user = guard.user;

  const body = await req.json().catch(() => ({}));

  // PUT accepts a partial body — admins update one knob at a time
  // from the dashboard. Previously the validator's defaults-as-base
  // behavior meant any unsupplied field was reset to its default and
  // written back, so updating Voiceovers silently clobbered the
  // admin's earlier customization of Video worker and vice-versa.
  // Read the current row first and merge the partial on top, so the
  // final write only touches fields the admin actually changed.
  const { data: currentRow } = await supabase
    .from("product_config")
    .select("batched_processes")
    .eq("service", "_global")
    .single();
  const current = coerceConcurrencyConfig(
    (currentRow as { batched_processes?: unknown } | null)?.batched_processes,
  );
  const merged: Record<string, unknown> = { ...current, ...(body as object) };

  const parsed = validateConcurrencyInput(merged);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const { error } = await supabase
    .from("product_config")
    .update({ batched_processes: parsed.value })
    .eq("service", "_global");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  invalidateConcurrencyConfigCache();
  return NextResponse.json({ ok: true, value: parsed.value });
}
