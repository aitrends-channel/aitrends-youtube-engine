import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { ONE_CLICK_HIDDEN } from "@/lib/feature-flags";
import { isAdminUser } from "@/lib/admin";
import {
  getOneClickConfig,
  saveOneClickConfig,
  validateConfig,
  emptyConfig,
} from "@/lib/one-click/config";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

// The user's 1Click preset. GET returns { config, configured } —
// `configured: false` (with an empty scaffold) tells the client to
// open the setup UI before the first 1Click run. PUT validates and
// saves; the payload becomes the snapshot source for future kickoffs
// (in-flight runs keep the snapshot they started with).

/** 1Click is hidden from customers by ONE_CLICK_HIDDEN, and the flag only ever
 *  hid the buttons: these routes were reachable by anyone signed in. Nothing
 *  linked to them, which is not the same as nothing being able to reach them —
 *  and a run started here spends real provider money on Heclus's account.
 *  Admins are exempt so the feature stays testable while it is hidden. */
function oneClickBlocked(user: User): Response | null {
  if (!ONE_CLICK_HIDDEN || isAdminUser(user)) return null;
  return new Response(JSON.stringify({ error: "1Click is not available yet." }), {
    status: 403,
    headers: { "Content-Type": "application/json" },
  });
}

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  const blocked = oneClickBlocked(user);
  if (blocked) return blocked;

  try {
    const config = await getOneClickConfig(user.id);
    return NextResponse.json({
      configured: config !== null,
      config: config ?? emptyConfig(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to load 1Click config" },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  const blocked = oneClickBlocked(user);
  if (blocked) return blocked;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const result = validateConfig(body);
  if (typeof result === "string") {
    return NextResponse.json({ error: result }, { status: 400 });
  }

  try {
    await saveOneClickConfig(user.id, result);
    return NextResponse.json({ ok: true, config: result });
  } catch (err) {
    // 42703 = column missing (migration 100 not applied yet).
    const msg = err instanceof Error ? err.message : "Failed to save 1Click config";
    const hint = msg.includes("one_click_config")
      ? "1Click settings column missing — run supabase/migrations/100_unify_one_click_config.sql first."
      : msg;
    return NextResponse.json({ error: hint }, { status: 500 });
  }
}
