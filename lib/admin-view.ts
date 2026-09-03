"use client";

import { useEffect, useState } from "react";
import { isHeclusCreditsPlan } from "@/lib/plan-tier";
import { isAdminEmail } from "@/lib/admin";

// Let an admin look at the app as either kind of account.
//
// Plan decides a growing number of things: whether the Cost button is there,
// whether the Logs button is, which table the cost page renders. Only one of
// those is ever reachable from a given account, so the half you are not on is
// impossible to check without changing somebody's plan.
//
// A view, not a setting. It changes what this browser renders and nothing
// about the account, it is offered to admins only, and it is deliberately not
// sent to the server: an endpoint that trusted it would be a way to be billed
// as the other kind of user.
//
// In localStorage rather than a URL or a context, because it has to survive
// navigating between pages that do not share a provider, and because a switch
// that resets on every page is not a switch.

const KEY = "heclus:admin-plan-view";
const EVENT = "heclus:admin-plan-view-changed";
/** The same choice, where the server can see it. localStorage cannot cross the
 *  wire, and the switch is no longer only about what renders: on "new" the
 *  admin's work is billed to the credit wallet, on "old" to their own keys.
 *  Honoured for admins only — see lib/admin-view-server.ts — so a forged cookie
 *  buys a non-admin nothing. */
export const ADMIN_PLAN_VIEW_COOKIE = "heclus_admin_plan_view";

/** "new" is a Heclus Credits account, "old" is a BYO one. */
export type AdminPlanView = "new" | "old";

export function readAdminPlanView(): AdminPlanView | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "new" || v === "old" ? v : null;
  } catch {
    // Private mode, or storage blocked. No override is the right answer.
    return null;
  }
}

export function setAdminPlanView(view: AdminPlanView | null): void {
  try {
    if (view) window.localStorage.setItem(KEY, view);
    else window.localStorage.removeItem(KEY);
  } catch { /* the switch still works for this render */ }
  // Written as a cookie too, so the server bills the account the way the switch
  // says. A year, because the switch is meant to survive a session; clearing it
  // expires the cookie rather than leaving the last choice behind.
  try {
    document.cookie = view
      ? `${ADMIN_PLAN_VIEW_COOKIE}=${view}; path=/; max-age=31536000; samesite=lax`
      : `${ADMIN_PLAN_VIEW_COOKIE}=; path=/; max-age=0; samesite=lax`;
  } catch { /* cookies blocked — the view is still right in this tab */ }
  // `storage` only fires in other tabs, so the components in this one are told
  // directly. Without it the switch moves and nothing else on the page does.
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** The override, kept in step across every component that reads it. */
export function useAdminPlanView(): AdminPlanView | null {
  const [view, setView] = useState<AdminPlanView | null>(null);
  useEffect(() => {
    const sync = () => setView(readAdminPlanView());
    sync();
    window.addEventListener(EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return view;
}

/**
 * Whether to render the credit-plan version of something.
 *
 * The override only applies to an admin. Everyone else gets their real plan
 * however stale a value might be sitting in their browser.
 */
export function useOnCreditsPlan(plan: string | null | undefined, isAdmin: boolean): boolean {
  const override = useAdminPlanView();
  if (isAdmin && override) return override === "new";
  return isHeclusCreditsPlan(plan);
}


/**
 * The viewer's plan and admin status, and whether to render the credit-plan
 * version of a surface.
 *
 * Three components were each running the same auth read to answer the same
 * question, and each was one edit away from disagreeing with the others about
 * what an admin is. getUser resolves from the cached session, so this costs a
 * render rather than a request.
 */
export function useViewerPlan(): { plan: string | null; isAdmin: boolean; onCredits: boolean } {
  const [plan, setPlan] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    let live = true;
    void import("@/lib/supabase/browser").then(({ createSupabaseBrowserClient }) =>
      createSupabaseBrowserClient().auth.getUser().then(({ data }) => {
        if (!live) return;
        const meta = (data.user?.app_metadata ?? {}) as { plan?: unknown; is_admin?: unknown };
        if (typeof meta.plan === "string") setPlan(meta.plan);
        if (meta.is_admin === true || isAdminEmail(data.user?.email)) setIsAdmin(true);
      }),
    );
    return () => { live = false; };
  }, []);
  const onCredits = useOnCreditsPlan(plan, isAdmin);
  return { plan, isAdmin, onCredits };
}
