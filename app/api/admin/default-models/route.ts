import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

const ADMIN_EMAIL = "prioritylearn@gmail.com";

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  if (user.email !== ADMIN_EMAIL) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data, error } = await supabase
    .from("product_config")
    .select("default_image_model, default_video_model")
    .eq("service", "_global")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({
    default_image_model: data?.default_image_model ?? null,
    default_video_model: data?.default_video_model ?? null,
  });
}

export async function PUT(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  if (user.email !== ADMIN_EMAIL) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => ({})) as {
    default_image_model?: string | null;
    default_video_model?: string | null;
  };

  const update: Record<string, string | null> = {};
  if ("default_image_model" in body) update.default_image_model = body.default_image_model || null;
  if ("default_video_model" in body) update.default_video_model = body.default_video_model || null;

  if (!Object.keys(update).length) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  const { error } = await supabase
    .from("product_config")
    .update(update)
    .eq("service", "_global");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
