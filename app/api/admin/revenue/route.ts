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
  occurred_at: string | null;
  user_email: string | null;
  plan: string | null;
  event_type: string | null;
  dodo_payment_id: string | null;
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const [eventsRes, cutoffRes, authUsersRes] = await Promise.all([
    supabase
      .from("revenue_events")
      .select("amount_cents, occurred_at, user_email, plan, event_type, dodo_payment_id")
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

  // Admin self-payments are stripped from aggregates only on the
  // live production deployment (HECLUS_ENV=production). Dev + staging
  // keep them so we can verify our own test purchases land correctly.
  const filterAdmins = isProductionEnv();
  const adminEmails = new Set<string>();
  if (filterAdmins) {
    for (const u of authUsersRes.data?.users ?? []) {
      if (isAdminUser(u) && u.email) adminEmails.add(u.email.toLowerCase());
    }
  }

  const allRows = (data ?? []) as RevenueRow[];
  // Strip admin self-payments from every aggregate. The full set is
  // still available via allRows for debugging; everything below
  // operates on the customer-only `rows`.
  const rows = allRows.filter((r) => {
    const email = r.user_email?.toLowerCase();
    return !email || !adminEmails.has(email);
  });

  // Total — full lifetime revenue regardless of cutoff.
  const totalCents = rows.reduce((sum, r) => sum + (r.amount_cents ?? 0), 0);

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
    const cents = r.amount_cents ?? 0;
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
    monthlyMap.set(month, (monthlyMap.get(month) ?? 0) + (r.amount_cents ?? 0));
  }
  const last12Months = last12.map((month) => ({
    month,
    amountCents: monthlyMap.get(month) ?? 0,
  }));

  // Recent events — capped so the response payload stays small for
  // the admin Revenue tab. Full table can be paginated later if
  // anyone needs deeper history.
  const recentEvents = rows.slice(0, 50).map((r) => ({
    amountCents: r.amount_cents ?? 0,
    occurredAt: r.occurred_at,
    userEmail: r.user_email,
    plan: r.plan,
    eventType: r.event_type,
    dodoPaymentId: r.dodo_payment_id,
  }));

  return NextResponse.json({
    totalCents,
    mrrCents,
    arrCents,
    payingUserCount,
    launchedAt,
    last12Months,
    recentEvents,
    eventCount: rows.length,
  });
}
