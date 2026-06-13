import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabase as serviceClient } from "@/lib/supabase/client";
import { isAdminUser } from "@/lib/admin";

export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const next = searchParams.get("next") ?? "/";
  const reset = searchParams.get("reset") === "true";

  const destination = new URL(`${origin}${next}`);
  if (reset) destination.searchParams.set("reset", "true");

  const response = NextResponse.redirect(destination.toString());

  if (code) {
    const cookieStore = await cookies();

    // Write session cookies directly onto the redirect response so they
    // survive the redirect (next/headers cookies() does not carry through
    // NextResponse.redirect automatically).
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll();
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) => {
              response.cookies.set(name, value, options);
            });
          },
        },
      }
    );

    const { data: { user } } = await supabase.auth.exchangeCodeForSession(code);

    const isSetPasswordFlow = next.startsWith("/set-password");

    if (user && !isSetPasswordFlow) {
      // isAdminUser covers both the legacy hardcoded founder admin
      // and any user promoted via the dashboard (app_metadata.is_admin).
      // Treating admins as "paid" here lets them bypass the allowlist
      // gate downstream, matching the original founder behavior.
      const isPaid = user.app_metadata?.paid === true || isAdminUser(user);

      // Skip the allowlist gate for OAuth users. The allowlist exists to
      // restrict email/password signups to manually invited addresses;
      // OAuth users already proved their identity via the provider, so
      // we let them through and rely on the subscription paywall
      // downstream to gate actual product usage.
      const provider = user.app_metadata?.provider;
      const isOAuth = typeof provider === "string" && provider !== "email";

      if (!isPaid && !isOAuth) {
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

  return response;
}
