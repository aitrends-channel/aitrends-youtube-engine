import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";
import { isAdminUser } from "@/lib/admin";
import { getQuotaConfig, capFromConfig, AI33_TTS_USD_PER_MILLION_CHARS } from "@/lib/quota-config";

export const dynamic = "force-dynamic";

// What the perks we pay for have actually consumed, overall and per user.
//
// Source is free_usage: one row per (user, day, kind), incremented by
// lib/freeUsage.ts whenever a generation runs on a Heclus-funded provider
// rather than the client's own key. That table is the only record of this
// spend — it never reaches project_costs, which tracks what clients spend on
// their own credentials.
//
// Reports ai33 only. Qwen isn't reachable in the picker, and "tts_chars" and
// "image" belong to BYO providers that were removed, so all three are history
// rather than anything to watch. The response stays keyed by kind and the
// panel renders whatever arrives, so putting a kind back is a one-line change
// here.

const DAYS = 30;

/** Kinds worth reporting, in display order. */
const REPORTED_KINDS = ["ai33_tts_chars", "free_image_credits"] as const;
const IS_REPORTED = (kind: string) => (REPORTED_KINDS as readonly string[]).includes(kind);

/** Only ai33 has a configured per-plan allowance to compare usage against. */
const QUOTA_KIND = "ai33_tts_chars";

export interface FreeUsageUserRow {
  userId: string;
  email: string;
  plan: string;
  isAdmin: boolean;
  /** Characters today, per kind. free_usage buckets by UTC day, so this is
   *  the finest granularity available: there is no hourly counter. */
  today: Record<string, number>;
  /** Characters this calendar month, per kind. */
  month: Record<string, number>;
  /** Characters over all time, per kind. */
  allTime: Record<string, number>;
  /** ai33 allowance for this user's plan, and how much of it is gone. */
  quota: number;
  quotaPct: number | null;
  lastUsed: string | null;
}

export interface FreeUsageResult {
  /** Every kind present in the table, active ones first. */
  kinds: string[];
  activeKinds: string[];
  totals: {
    today: Record<string, number>;
    month: Record<string, number>;
    allTime: Record<string, number>;
    /** Accounts with any usage today / this month / ever. */
    usersToday: number;
    usersMonth: number;
    usersAllTime: number;
    /** Sum of ai33 allowances across accounts that used any this month. */
    quotaAllocatedMonth: number;
  };
  /** Oldest-first, zero-filled, one entry per day for the last 30 days. */
  daily: { date: string; byKind: Record<string, number> }[];
  users: FreeUsageUserRow[];
  /** USD per million ai33 characters, or null when the env var is unset. */
  usdPerMillion: number | null;
  /** Estimated ai33 spend this month, null when no rate is configured. */
  estimatedMonthUsd: number | null;
  month: string;
  /** UTC date the "today" figures cover. */
  today: string;
}

interface UsageRow {
  user_id: string;
  day: string;
  kind: string;
  count: number;
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  // Page through the table: it is one row per user per day per kind, so it
  // grows steadily and a 1000-row cap would quietly truncate the totals.
  const PAGE = 1000;
  const rows: UsageRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await supabase
      .from("free_usage")
      .select("user_id, day, kind, count")
      .order("day", { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data || data.length === 0) break;
    rows.push(...(data as UsageRow[]));
    if (data.length < PAGE) break;
  }

  const monthStart = new Date().toISOString().slice(0, 8) + "01";
  const isThisMonth = (day: string) => day >= monthStart;
  // free_usage.day defaults to CURRENT_DATE on the database, so "today" is a
  // UTC date comparison, not a local one.
  const todayKey = new Date().toISOString().slice(0, 10);

  const kindsSeen = new Set<string>();
  const totalsToday: Record<string, number> = {};
  const totalsMonth: Record<string, number> = {};
  const totalsAll: Record<string, number> = {};
  const perUser = new Map<string, { today: Record<string, number>; month: Record<string, number>; allTime: Record<string, number>; lastUsed: string | null }>();

  for (const r of rows) {
    const n = Number(r.count) || 0;
    if (n <= 0 || !IS_REPORTED(r.kind)) continue;
    kindsSeen.add(r.kind);
    totalsAll[r.kind] = (totalsAll[r.kind] ?? 0) + n;
    if (isThisMonth(r.day)) totalsMonth[r.kind] = (totalsMonth[r.kind] ?? 0) + n;
    if (r.day === todayKey) totalsToday[r.kind] = (totalsToday[r.kind] ?? 0) + n;

    let u = perUser.get(r.user_id);
    if (!u) { u = { today: {}, month: {}, allTime: {}, lastUsed: null }; perUser.set(r.user_id, u); }
    u.allTime[r.kind] = (u.allTime[r.kind] ?? 0) + n;
    if (isThisMonth(r.day)) u.month[r.kind] = (u.month[r.kind] ?? 0) + n;
    if (r.day === todayKey) u.today[r.kind] = (u.today[r.kind] ?? 0) + n;
    if (!u.lastUsed || r.day > u.lastUsed) u.lastUsed = r.day;
  }

  // Emails and plans come from auth, the same place the rest of the admin
  // dashboard reads them. A deleted account keeps its rows (free_usage
  // cascades on delete, so in practice this is only a lookup miss), and is
  // labelled rather than dropped so the totals still add up.
  const { data: userList } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  const byId = new Map((userList?.users ?? []).map((u) => [u.id, u]));
  const quotaConfig = await getQuotaConfig();

  const sumOf = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);

  const users: FreeUsageUserRow[] = [...perUser.entries()].map(([userId, u]) => {
    const account = byId.get(userId);
    const plan = ((account?.app_metadata?.plan as string | undefined) ?? "").trim() || "free";
    const admin = account ? isAdminUser(account) : false;
    const quota = capFromConfig(quotaConfig, QUOTA_KIND, plan, admin);
    const usedAgainstQuota = u.month[QUOTA_KIND] ?? 0;
    return {
      userId,
      email: account?.email ?? "(deleted account)",
      plan,
      isAdmin: admin,
      today: u.today,
      month: u.month,
      allTime: u.allTime,
      quota,
      quotaPct: quota > 0 ? Math.round((usedAgainstQuota / quota) * 100) : null,
      lastUsed: u.lastUsed,
    };
  });

  // Heaviest this month first: the reason to open this view is to find who is
  // consuming what we fund. Accounts idle this month fall back to all-time
  // order rather than an arbitrary one.
  users.sort((a, b) => sumOf(b.month) - sumOf(a.month) || sumOf(b.allTime) - sumOf(a.allTime));

  const dayKeys: string[] = [];
  const today = new Date();
  for (let i = DAYS - 1; i >= 0; i--) {
    dayKeys.push(new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  }
  const dailyMap = new Map<string, Record<string, number>>(dayKeys.map((d) => [d, {}]));
  for (const r of rows) {
    if (!IS_REPORTED(r.kind)) continue;
    const bucket = dailyMap.get(r.day);
    if (!bucket) continue;
    bucket[r.kind] = (bucket[r.kind] ?? 0) + (Number(r.count) || 0);
  }

  const monthAi33 = totalsMonth[QUOTA_KIND] ?? 0;
  const kinds = REPORTED_KINDS.filter((k) => kindsSeen.has(k));

  return NextResponse.json({
    kinds,
    activeKinds: [...REPORTED_KINDS],
    totals: {
      today: totalsToday,
      month: totalsMonth,
      allTime: totalsAll,
      usersToday: users.filter((u) => sumOf(u.today) > 0).length,
      usersMonth: users.filter((u) => sumOf(u.month) > 0).length,
      usersAllTime: users.length,
      quotaAllocatedMonth: users
        .filter((u) => (u.month[QUOTA_KIND] ?? 0) > 0)
        .reduce((sum, u) => sum + u.quota, 0),
    },
    daily: dayKeys.map((date) => ({ date, byKind: dailyMap.get(date) ?? {} })),
    users,
    usdPerMillion: AI33_TTS_USD_PER_MILLION_CHARS,
    estimatedMonthUsd: AI33_TTS_USD_PER_MILLION_CHARS !== null
      ? (monthAi33 / 1_000_000) * AI33_TTS_USD_PER_MILLION_CHARS
      : null,
    month: monthStart.slice(0, 7),
    today: todayKey,
  } satisfies FreeUsageResult);
}
