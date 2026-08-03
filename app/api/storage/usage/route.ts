export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { storageStatus } from "@/lib/storage-quota";
import type { User } from "@supabase/supabase-js";

// Powers the account page's storage meter. measuredAt is exposed because the
// number is a cached sweep (migration 112) — someone who just deleted a
// project needs to know why the bar hasn't moved.
export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const status = await storageStatus(user);
    return NextResponse.json(status);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
