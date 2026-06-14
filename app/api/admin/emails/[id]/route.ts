import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/emails/[id]
 *
 * Return the full email row including body_text + body_html. Marks
 * inbound rows as read as a side effect (only flips the bit if it
 * wasn't already set, to avoid noisy DB writes on re-opens).
 */
export async function GET(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const { id } = params;
  const { data, error } = await supabase
    .from("emails")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Mark inbound as read once we've actually served the body.
  if (data.direction === "inbound" && !data.is_read) {
    await supabase.from("emails").update({ is_read: true }).eq("id", id);
    data.is_read = true;
  }

  return NextResponse.json({ email: data });
}
