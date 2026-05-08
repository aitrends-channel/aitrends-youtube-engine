import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabase as serviceClient } from "@/lib/supabase/client";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.exchangeCodeForSession(code);

    if (user) {
      // Paid users carry app_metadata.paid; allowed_emails covers admin/comped accounts
      const isPaid = user.app_metadata?.paid === true;
      if (!isPaid) {
        const { data: allowed } = await serviceClient
          .from("allowed_emails")
          .select("email")
          .eq("email", user.email!.toLowerCase())
          .maybeSingle();

        if (!allowed) {
          await supabase.auth.signOut();
          return NextResponse.redirect(`${origin}/login?error=unauthorized`);
        }
      }
    }
  }

  return NextResponse.redirect(`${origin}${next}`);
}
