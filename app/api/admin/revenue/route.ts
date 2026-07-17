import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";
import { isAdminUser } from "@/lib/admin";
import { isProductionEnv } from "@/lib/env";

// Revenue stats sourced from the immutable revenue_events ledger
// (migration 066). Built so the admin Revenue tab can show real
// historical totals — they survive user deletion because
// revenue_events.user_id has no foreign key to auth.users.
//
// MRR / ARR are intentionally NOT computed here: those are
// "currently paid users × plan price," which is a function of
// auth.users.app_metadata state at this moment, not historical
// revenue. The Revenue tab keeps its existing MRR card sourced
// from the users array on /api/admin/stats.

export const dynamic = "force-dynamic";

interface RevenueRow {
  amount_cents: number | null;
  currency: string | null;
  occurred_at: string | null;
  user_email: string | null;
  plan: string | null;
  event_type: string | null;
  dodo_payment_id: string | null;
}

// The ledger is (nearly) single-currency: writers store Dodo's USD
// settlement amount, but EUR/GBP customers settle in their own currency
// (localized Founder pricing), so those rows are truthfully denominated
// in eur/gbp. Convert at read time with static approximate rates — at a
// $40 price point the rounding error is cents. Revisit if non-USD
// volume ever becomes material.
const USD_RATE: Record<string, number> = { usd: 1, eur: 1.09, gbp: 1.27 };
function usdCents(r: RevenueRow): number {
  const rate = USD_RATE[(r.currency ?? "usd").toLowerCase()] ?? 1;
  return Math.round((r.amount_cents ?? 0) * rate);
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const [eventsRes, cutoffRes, authUsersRes] = await Promise.all([
    supabase
      .from("revenue_events")
      .select("amount_cents, currency, occurred_at, user_email, plan, event_type, dodo_payment_id")
      .order("occurred_at", { ascending: false }),
    // activity_cutoff_at is set by the Launch action on the _global
    // singleton. We surface it as launchedAt so the Revenue tab can
    // scope per-user views ("only show subscriptions taken out
    // after launch") consistently with the activity chart.
    supabase
      .from("product_config")
      .select("activity_cutoff_at")
      .eq("service", "_global")
      .maybeSingle(),
    // Pull current admin emails so we can strip out our own test
    // purchases from every aggregate below. Caveat: admins who have
    // been deleted since paying won't be in this list — their
    // revenue_events rows would still count toward stats. In
    // practice admins are kept across launches via the exclude list,
    // so this is fine.
    supabase.auth.admin.listUsers({ perPage: 1000 }),
  ]);

  if (eventsRes.error) {
    return NextResponse.json({ error: eventsRes.error.message }, { status: 500 });
  }

  const data = eventsRes.data;
  const launchedAt = (cutoffRes.data as { activity_cutoff_at: string | null } | null)?.activity_cutoff_at ?? null;

  // Admin self-payments are stripped from every aggregate in every
  // environment so the Revenue tab is a customer-only view. Admins
  // testing the payment flow (production-test plan, dev purchases)
  // land in revenue_events but never inflate MRR / ARR / totals.
  const adminEmails = new Set<string>();
  for (const u of authUsersRes.data?.users ?? []) {
    if (isAdminUser(u) && u.email) adminEmails.add(u.email.toLowerCase());
  }

  const allRows = (data ?? []) as RevenueRow[];
  // Strip admin self-payments from every aggregate. Additionally on
  // production, drop events older than launch (activity_cutoff_at) so
  // pre-launch QA charges don't inflate day-1 revenue. Dev + staging
  // keep the full history so we can validate historical fixtures.
  const scopeToPostLaunch = isProductionEnv() && launchedAt !== null;
  const launchedAtMs = launchedAt ? new Date(launchedAt).getTime() : null;
  const rows = allRows.filter((r) => {
    const email = r.user_email?.toLowerCase();
    if (email && adminEmails.has(email)) return false;
    if (scopeToPostLaunch && launchedAtMs !== null) {
      if (!r.occurred_at) return false;
      if (new Date(r.occurred_at).getTime() < launchedAtMs) return false;
    }
    return true;
  });

  // Total — full lifetime revenue regardless of cutoff, in USD cents.
  const totalCents = rows.reduce((sum, r) => sum + usdCents(r), 0);

  // Lifetime revenue + payment count per plan, for the Total card's
  // breakdown line and the payments-table filter cards. Events written
  // before the plan was known land under "other".
  const byPlan: Record<string, { cents: number; count: number }> = {};
  for (const r of rows) {
    const plan = (r.plan ?? "other").toLowerCase();
    const entry = (byPlan[plan] ??= { cents: 0, count: 0 });
    entry.cents += usdCents(r);
    entry.count += 1;
  }

  // Rolling-window aggregates. Sourced from revenue_events so the
  // numbers survive user deletion. Caveats:
  //   - MRR is a rolling-30-day actual-revenue figure. Annual plans
  //     (Founder) get counted as a lump sum in their billing month
  //     rather than amortized across 12 — fine for "what did we
  //     actually collect" but slightly overstates "true recurring."
  //   - ARR is the rolling-365-day actual-revenue figure for the
  //     same reason.
  const now = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
  const ONE_YEAR_MS    = 365 * 24 * 60 * 60 * 1000;
  let mrrCents = 0;
  let arrCents = 0;
  const payingEmails = new Set<string>();
  for (const r of rows) {
    const occurred = r.occurred_at ? new Date(r.occurred_at).getTime() : 0;
    const cents = usdCents(r);
    if (now - occurred <= THIRTY_DAYS_MS) mrrCents += cents;
    if (now - occurred <= ONE_YEAR_MS)    arrCents += cents;
    if (r.user_email) payingEmails.add(r.user_email.toLowerCase());
  }
  const payingUserCount = payingEmails.size;

  // Monthly aggregation over the trailing 12 months. Keys are
  // "YYYY-MM" to match the rest of the admin stats route's date
  // shape; the client formats for display.
  const last12: string[] = Array.from({ length: 12 }, (_, i) => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - (11 - i));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  });
  const monthlyMap = new Map<string, number>();
  for (const r of rows) {
    if (!r.occurred_at) continue;
    const month = new Date(r.occurred_at).toISOString().slice(0, 7);
    monthlyMap.set(month, (monthlyMap.get(month) ?? 0) + usdCents(r));
  }
  const last12Months = last12.map((month) => ({
    month,
    amountCents: monthlyMap.get(month) ?? 0,
  }));

  // Daily sales for the trailing 30 days — feeds the Reports tab's
  // sales-activity line. Amount + payment count per UTC day.
  const dailyMap = new Map<string, { cents: number; count: number }>();
  for (const r of rows) {
    if (!r.occurred_at) continue;
    const day = new Date(r.occurred_at).toISOString().slice(0, 10);
    const e = dailyMap.get(day) ?? { cents: 0, count: 0 };
    e.cents += usdCents(r);
    e.count += 1;
    dailyMap.set(day, e);
  }
  const daily = Array.from({ length: 30 }, (_, i) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - (29 - i));
    const day = d.toISOString().slice(0, 10);
    const e = dailyMap.get(day);
    return { date: day, amountCents: e?.cents ?? 0, count: e?.count ?? 0 };
  });

  // Recent events — capped so the response payload stays small for
  // the admin Revenue tab. Full table can be paginated later if
  // anyone needs deeper history.
  const recentEvents = rows.slice(0, 50).map((r) => ({
    // USD-normalized so the client's $-formatting stays truthful for
    // the eur/gbp-settled rows.
    amountCents: usdCents(r),
    occurredAt: r.occurred_at,
    userEmail: r.user_email,
    plan: r.plan,
    eventType: r.event_type,
    dodoPaymentId: r.dodo_payment_id,
  }));

  return NextResponse.json({
    totalCents,
    byPlan,
    mrrCents,
    arrCents,
    payingUserCount,
    launchedAt,
    last12Months,
    daily,
    recentEvents,
    eventCount: rows.length,
  });
}
