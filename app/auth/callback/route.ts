import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { supabase as serviceClient } from "@/lib/supabase/client";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";
  const reset = searchParams.get("reset") === "true";

  // Build the final redirect URL, forwarding the reset param if present
  const destination = new URL(`${origin}${next}`);
  if (reset) destination.searchParams.set("reset", "true");

  const isSetPasswordFlow = next.startsWith("/set-password");

  if (code) {
    const supabase = await createSupabaseServerClient();
    const { data: { user } } = await supabase.auth.exchangeCodeForSession(code);

    // Invite and password-reset flows land here before the user has paid —
    // skip the access check and let them reach /set-password.
    if (user && !isSetPasswordFlow) {
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

  return NextResponse.redirect(destination.toString());
}
