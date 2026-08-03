export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { storageStatus } from "@/lib/storage-quota";
import type { User } from "@supabase/supabase-js";

// Powers the storage meter on the account page. measuredAt is exposed so
// the UI can say when the number is from — usage is a cached sweep, not a
// live sum (see migration 112), and a user who just deleted a project
// needs to know why the bar hasn't moved yet.
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
