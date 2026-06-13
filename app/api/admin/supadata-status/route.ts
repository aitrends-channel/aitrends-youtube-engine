import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";

export const dynamic = "force-dynamic";

export interface SupadataStatus {
  plan: string;
  usedCredits: number;
  maxCredits: number;
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  // Prefer a key stored on the admin-managed product_keys row so the
  // status reflects whichever key is actually in use, falling back to
  // the env var for local dev or pre-DB setups.
  const { data: row } = await supabase
    .from("product_config")
    .select("keys, current_index")
    .eq("service", "supadata_api_key")
    .maybeSingle();

  const dbKey = row?.keys?.[row.current_index ?? 0];
  const apiKey = (typeof dbKey === "string" && dbKey.trim()) || process.env.SUPADATA_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Supadata API key not configured" }, { status: 400 });
  }

  try {
    const res = await fetch("https://api.supadata.ai/v1/me", {
      headers: { "x-api-key": apiKey },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return NextResponse.json({ error: `Supadata ${res.status}: ${body.slice(0, 200)}` }, { status: 502 });
    }
    const data = await res.json() as { plan?: string; usedCredits?: number; maxCredits?: number };
    return NextResponse.json({
      plan: data.plan ?? "Unknown",
      usedCredits: typeof data.usedCredits === "number" ? data.usedCredits : 0,
      maxCredits: typeof data.maxCredits === "number" ? data.maxCredits : 0,
    } satisfies SupadataStatus);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Status fetch failed" }, { status: 502 });
  }
}
