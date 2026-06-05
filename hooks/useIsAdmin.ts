"use client";

import { useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { isAdminEmail } from "@/lib/admin";

// Returns whether the currently-signed-in user is an admin. Reads the
// user from the Supabase browser client (which caches the session) and
// runs the same isAdminEmail check the server uses. One auth round-trip
// per component mount; tab-cached after that.
export function useIsAdmin(): boolean {
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    const sb = createSupabaseBrowserClient();
    sb.auth.getUser().then(({ data }) => {
      setIsAdmin(isAdminEmail(data.user?.email));
    });
  }, []);
  return isAdmin;
}
