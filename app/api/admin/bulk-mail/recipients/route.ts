import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-server";
import { getBulkMailAudience, isBulkMailPhase, clampIdleHours } from "@/lib/admin/bulk-mail-audience";

export const dynamic = "force-dynamic";

// Preview endpoint for the admin "Bulk mail" tab — returns the exact set
// of users the send route will target for ?phase= (and optional
// ?idleHours=). No side effects.
export async function GET(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const url = new URL(req.url);
  const phase = url.searchParams.get("phase");
  if (!isBulkMailPhase(phase)) {
    return NextResponse.json({ error: "Unknown or missing phase" }, { status: 400 });
  }
  const idleHours = clampIdleHours(url.searchParams.get("idleHours"));

  try {
    const { recipients, videos } = await getBulkMailAudience(phase, idleHours);
    return NextResponse.json({ recipients, videos, total: recipients.length, phase, idleHours });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to load recipients" },
      { status: 500 },
    );
  }
}
