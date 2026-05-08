import { createSupabaseServerClient } from "./server";
import type { User } from "@supabase/supabase-js";

export async function getRequiredUser(): Promise<User> {
  const client = await createSupabaseServerClient();
  const { data: { user }, error } = await client.auth.getUser();
  if (user) return user;

  // getUser() requires a network round-trip to Supabase. If the app is
  // temporarily offline, fall back to the session stored in the cookie so
  // the user isn't kicked out during connectivity loss.
  if (error) {
    const { data: { session } } = await client.auth.getSession();
    if (session?.user) return session.user;
  }

  throw new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
