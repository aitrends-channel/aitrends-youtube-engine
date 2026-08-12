import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";
import { getSupportAgentConfig, type SupportAgentConfig } from "@/lib/support-agent/agent";

export const dynamic = "force-dynamic";

// Read and write the support agent's switches. This exists so the automated
// reply can be stopped from the dashboard: the failure mode is a wrong answer
// already sitting in a customer's inbox, and the fix has to be one click away,
// not a SQL prompt.

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  return NextResponse.json({ config: await getSupportAgentConfig() });
}

export async function PUT(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const body = await req.json().catch(() => null) as Partial<SupportAgentConfig> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "Body must be an object" }, { status: 400 });
  }

  const current = await getSupportAgentConfig();
  const bool = (v: unknown, fallback: boolean) => (typeof v === "boolean" ? v : fallback);
  const clamp = (v: unknown, fallback: number, min: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(Math.round(v), min), max) : fallback;

  const next: SupportAgentConfig = {
    chat_enabled: bool(body.chat_enabled, current.chat_enabled),
    auto_reply_enabled: bool(body.auto_reply_enabled, current.auto_reply_enabled),
    auto_reply_emails_enabled: bool(body.auto_reply_emails_enabled, current.auto_reply_emails_enabled),
    auto_reply_dry_run: bool(body.auto_reply_dry_run, current.auto_reply_dry_run),
    // A grace period under a minute would race an admin who is already typing;
    // a day-long one is indistinguishable from off.
    auto_reply_delay_minutes: clamp(body.auto_reply_delay_minutes, current.auto_reply_delay_minutes, 1, 1440),
    auto_reply_max_per_run: clamp(body.auto_reply_max_per_run, current.auto_reply_max_per_run, 1, 50),
  };

  const { error } = await supabase
    .from("product_config")
    .update({ support_agent: next })
    .eq("service", "_global");
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, config: next });
}
