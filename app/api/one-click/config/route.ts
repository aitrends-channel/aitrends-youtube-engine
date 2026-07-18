import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
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

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

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
    // 42P01 = table missing (migration 097 not applied yet).
    const msg = err instanceof Error ? err.message : "Failed to save 1Click config";
    const hint = msg.includes("one_click_configs")
      ? "1Click table missing — run supabase/migrations/097_one_click.sql first."
      : msg;
    return NextResponse.json({ error: hint }, { status: 500 });
  }
}
