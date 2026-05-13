import { NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { supabase as serviceClient } from "@/lib/supabase/client";
import { isAdminEmail } from "@/lib/admin";

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
      const isPaid = user.app_metadata?.paid === true || isAdminEmail(user.email);
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

  return response;
}
