import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const ADMIN_EMAIL = "prioritylearn@gmail.com";

export async function PUT(
  req: Request,
  { params }: { params: { email: string } }
) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  if (user.email !== ADMIN_EMAIL) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const decoded = decodeURIComponent(params.email).toLowerCase().trim();

  // Admin accounts have unlimited niches by virtue of the isAdmin branch
  // in /api/projects and /api/usage. Setting an override on them would
  // also be inert for the admin themselves (since that branch runs
  // before the override read) but would still litter the DB and surface
  // misleadingly in the admin UI — reject the request outright.
  if (decoded === ADMIN_EMAIL) {
    return NextResponse.json({ error: "Cannot override niche limit for admin accounts" }, { status: 400 });
  }

  const body = await req.json().catch(() => ({})) as { override?: number | null };
  const raw = body.override;
  // Allow numeric values >= 0 or null. Anything else is a 400.
  if (raw !== null && raw !== undefined) {
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
      return NextResponse.json({ error: "override must be a non-negative integer or null" }, { status: 400 });
    }
  }
  const override: number | null = raw ?? null;

  // Resolve email → user_id via the auth admin API. listUsers caps at 1000
  // per page; mirrors what /api/admin/stats already does and matches the
  // existing DELETE handler in this folder.
  const { data: listData, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (listErr) return NextResponse.json({ error: listErr.message }, { status: 500 });
  const authUser = listData.users.find((u) => u.email?.toLowerCase() === decoded);
  if (!authUser) return NextResponse.json({ error: "User not found" }, { status: 404 });

  // Upsert — the user may not have an account_settings row yet (no
  // projects created), in which case we have to create one.
  const { error: upErr } = await supabase
    .from("account_settings")
    .upsert(
      { user_id: authUser.id, niche_limit_override: override },
      { onConflict: "user_id" }
    );
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  return NextResponse.json({ ok: true, override });
}
