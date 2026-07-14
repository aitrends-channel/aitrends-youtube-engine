import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { isAdminUser } from "@/lib/admin";

// Server-side gate for expired subscriptions. An expired subscriber
// keeps read access to their account, niches, and videos, but every
// spend-triggering action (new niche/video, assemble, script/prompts/
// visual-analysis/voiceover/image/video generation) is blocked until
// they renew.
//
// "Expired" only ever applies to accounts that at some point completed
// a purchase (paid_at / plan_expires_at / a Dodo subscription id).
// Never-paid demo and free-tier (BYO keys) users are NOT ex-subscribers
// — they're governed by their own caps, so this gate ignores them. A
// failed first payment attempt (dodo.event set, but no paid_at) also
// doesn't count as "ever subscribed".
export function subscriptionExpired(user: User): boolean {
  if (isAdminUser(user)) return false;
  const meta = (user.app_metadata ?? {}) as Record<string, unknown>;
  const dodo = (meta.dodo ?? {}) as Record<string, unknown>;

  const everSubscribed = Boolean(meta.paid_at || meta.plan_expires_at || dodo.subscription_id);
  if (!everSubscribed) return false;

  // Webhook-driven revocation: subscription.expired / subscription.failed
  // (and payment.failed) flip paid to false.
  if (meta.paid !== true) return true;

  // Time-driven fallback: the paid-through period has lapsed but the
  // expired webhook hasn't landed (or was missed). Cancelled-in-grace
  // users have paid=true and a future plan_expires_at, so they retain
  // access until the period actually ends.
  const expiresAt = typeof meta.plan_expires_at === "string" ? Date.parse(meta.plan_expires_at) : NaN;
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

/**
 * Drop-in guard for spend-triggering POST handlers. Returns a 403
 * response when the caller's subscription has expired, null otherwise.
 * The `subscriptionExpired` flag lets the client distinguish this from
 * other 403s and open the renewal modal.
 */
export function requireActiveSubscription(user: User): NextResponse | null {
  if (!subscriptionExpired(user)) return null;
  return NextResponse.json(
    {
      error: "Your subscription has expired. Renew your plan to keep creating and generating.",
      subscriptionExpired: true,
    },
    { status: 403 },
  );
}
