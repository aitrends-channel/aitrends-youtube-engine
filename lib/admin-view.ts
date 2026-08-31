"use client";

import { useEffect, useState } from "react";
import { isHeclusCreditsPlan } from "@/lib/plan-tier";

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
