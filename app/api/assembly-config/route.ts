import { NextResponse } from "next/server";
import { getConcurrencyConfig } from "@/lib/concurrency-config";

export const dynamic = "force-dynamic";

// Public-readable subset of the assembly config. Currently surfaces
// just whether per-beat Stage B encodes at the user's final
// resolution (vs the 720p intermediate). The assemble page reads
// this to label its in-progress preview block correctly — "Burning
// captions" when Stage F only has captions to do, "Captions + final
// resolution" when Stage F still has to upscale. No admin auth
// needed because the value is non-secret operational metadata.
export async function GET() {
  const cfg = await getConcurrencyConfig();
  return NextResponse.json({ beats_at_final_res: cfg.assembly_beats_at_final_res });
}
