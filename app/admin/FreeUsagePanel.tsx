"use client";

import { useState } from "react";
import useSWR from "swr";
import { Gift, Search, X } from "lucide-react";
import type { FreeUsageResult, FreeUsageUserRow } from "@/app/api/admin/free-usage/route";
import { GenAIProCard } from "@/components/admin/GenAIProCard";

// Perks Heclus funds: what they have consumed overall, and which accounts are
// consuming them. This spend never reaches project_costs, which records what
// clients spend on their own keys, so free_usage is the only place it shows up
// and this panel is the only place it is visible.

const fetcher = (url: string) => fetch(url).then((r) => r.json());

// free_usage buckets by UTC day, so "Today" is a day total rather than an
// hourly series. Same three ranges on both sections.
type Scope = "today" | "month" | "allTime";
const SCOPES: readonly (readonly [Scope, string])[] = [
  ["today", "Today"],
  ["month", "This month"],
  ["allTime", "All time"],
];

// Kinds carry their provider name: "ai33" on its own means nothing to anyone
// reading this later. Qwen stays mapped even though only ai33 is reported
// today, so re-reporting it needs no change here.
const KIND_LABEL: Record<string, string> = {
  ai33_tts_chars: "ai33 voiceover",
  qwen_tts_chars: "Qwen voiceover",
};

const KIND_UNIT: Record<string, string> = {
  ai33_tts_chars: "chars",
  qwen_tts_chars: "chars",
};

// One hue per kind, assigned in fixed order so a kind keeps its colour when
// another appears or drops out.
const KIND_COLOR: Record<string, string> = {
  ai33_tts_chars: "#9b7ff5",
  qwen_tts_chars: "#5bc48a",
};
const FALLBACK_COLOR = "#94a3b8";

function label(kind: string) { return KIND_LABEL[kind] ?? kind; }
function unit(kind: string) { return KIND_UNIT[kind] ?? ""; }
function color(kind: string) { return KIND_COLOR[kind] ?? FALLBACK_COLOR; }

function compact(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return Math.round(n).toString();
  if (n < 1_000_000) {
    const k = n / 1000;
    return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, "")}k`;
  }
  const m = n / 1_000_000;
  return m >= 100 ? `${Math.round(m)}M` : `${m.toFixed(1).replace(/\.0$/, "")}M`;
}

const cardStyle = { background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" } as const;

function Tile({ value, suffix, label: text, hint, tone }: { value: string; suffix?: string; label: string; hint?: string; tone?: string }) {
  return (
    <div className="rounded-2xl px-5 py-4 min-h-[96px]" style={cardStyle}>
      <p className="leading-none">
        <span className="text-2xl font-semibold tabular-nums" style={{ color: tone ?? "var(--c-90)" }}>{value}</span>
        {suffix && <span className="text-xs font-normal ml-1.5" style={{ color: "var(--c-50)" }}>{suffix}</span>}
      </p>
      <p className="text-xs mt-2" style={{ color: "var(--c-45)" }}>{text}</p>
      {hint && <p className="text-[10px] mt-1" style={{ color: "var(--c-35)" }}>{hint}</p>}
    </div>
  );
}

// Daily bars, stacked when more than one kind is reported. Only kinds measured
// in characters are plotted: a count of images would not share the axis.
function DailyChart({ daily, kinds }: { daily: FreeUsageResult["daily"]; kinds: string[] }) {
  const [hovered, setHovered] = useState<number | null>(null);
  const charKinds = kinds.filter((k) => unit(k) === "chars");

  const W = 760, H = 170, PAD_X = 16, PAD_T = 16, PAD_B = 26;
  const plotH = H - PAD_T - PAD_B;
  const slotW = (W - PAD_X * 2) / daily.length;
  const barW = Math.min(slotW - 6, 16);
  const totalFor = (d: FreeUsageResult["daily"][number]) =>
    charKinds.reduce((sum, k) => sum + (d.byKind[k] ?? 0), 0);
  const max = Math.max(...daily.map(totalFor), 1);

  const dayLabel = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });

  return (
    <div style={{ overflowX: "clip" }}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseLeave={() => setHovered(null)}>
        {[0.5, 1].map((f) => (
          <line key={f} x1={PAD_X} y1={PAD_T + plotH - f * plotH} x2={W - PAD_X} y2={PAD_T + plotH - f * plotH}
            stroke="rgba(0,0,0,0.06)" strokeWidth="1" />
        ))}
        <line x1={PAD_X} y1={PAD_T + plotH} x2={W - PAD_X} y2={PAD_T + plotH} stroke="rgba(0,0,0,0.12)" strokeWidth="1" />

        {daily.map((d, i) => {
          const cx = PAD_X + slotW * i + slotW / 2;
          const bx = cx - barW / 2;
          const total = totalFor(d);
          let y = PAD_T + plotH;
          const segments = charKinds.map((k) => {
            const v = d.byKind[k] ?? 0;
            if (v <= 0) return null;
            // 2px floor so a day with a handful of characters still registers,
            // and a 2px gap between segments so a stack reads as parts.
            const h = Math.max((v / max) * plotH, 2);
            y -= h;
            return { k, v, y, h };
          }).filter(Boolean) as { k: string; v: number; y: number; h: number }[];

          return (
            <g key={d.date} onMouseEnter={() => setHovered(i)}>
              <rect x={cx - slotW / 2} y={PAD_T} width={slotW} height={plotH} fill="transparent" />
              {segments.length === 0 ? (
                <rect x={bx} y={PAD_T + plotH - 1.5} width={barW} height={1.5} rx={0.75} fill="rgba(0,0,0,0.08)" />
              ) : segments.map((s, si) => (
                <rect key={s.k} x={bx} y={s.y + (si > 0 ? 1 : 0)} width={barW}
                  height={Math.max(s.h - (si > 0 ? 1 : 0), 1)}
                  rx={si === segments.length - 1 ? 2.5 : 0}
                  fill={color(s.k)} opacity={hovered === null || hovered === i ? 1 : 0.45} />
              ))}
              {i % 7 === 0 && (
                <text x={cx} y={PAD_T + plotH + 16} textAnchor="middle" fontSize="9" fill="var(--c-40)">
                  {dayLabel(d.date)}
                </text>
              )}
              {hovered === i && total > 0 && (
                <text x={Math.min(Math.max(cx, PAD_X + 30), W - PAD_X - 30)} y={PAD_T - 4}
                  textAnchor="middle" fontSize="10" fontWeight="600" fill="var(--c-75)">
                  {dayLabel(d.date)}: {compact(total)} chars
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {/* A legend for one series is noise: the card heading names it. It
          appears again on its own if a second kind is ever reported. */}
      {charKinds.length > 1 && (
        <div className="flex items-center gap-4 flex-wrap mt-1 px-1">
          {charKinds.map((k) => (
            <span key={k} className="inline-flex items-center gap-1.5 text-[11px]" style={{ color: "var(--c-50)" }}>
              <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: color(k) }} />
              {label(k)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// A percentage alone answers "how close to the cap" but not "how much is left
// to spend", which is the number you act on. Both figures are the monthly ones
// even when the table shows all time, because the allowance is monthly.
function QuotaBar({ used, quota, pct }: { used: number; quota: number; pct: number }) {
  const clamped = Math.min(pct, 100);
  const barColor = pct >= 100 ? "#e8745a" : pct >= 80 ? "#f0a855" : "#5bc48a";
  const remaining = quota - used;
  return (
    <div className="min-w-[150px]">
      <div className="flex items-center gap-2">
        <div className="flex-1 h-1.5 rounded-full overflow-hidden" style={{ background: "oklch(0 0 0 / 0.06)" }}>
          <div className="h-full rounded-full" style={{ width: `${clamped}%`, background: barColor }} />
        </div>
        <span className="text-[11px] tabular-nums shrink-0" style={{ color: pct >= 100 ? "#e8745a" : "var(--c-50)" }}>
          {pct}%
        </span>
      </div>
      <p className="text-[10px] tabular-nums mt-1" style={{ color: "var(--c-45)" }}>
        <span style={{ color: "var(--c-65)" }}>{compact(used)}</span> of {compact(quota)} used
        {remaining >= 0
          ? <> · <span style={{ color: "var(--c-65)" }}>{compact(remaining)}</span> left</>
          : <> · <span style={{ color: "#e8745a" }}>{compact(-remaining)} over</span></>}
      </p>
    </div>
  );
}

export default function FreeUsagePanel() {
  const { data, error, isLoading } = useSWR<FreeUsageResult>("/api/admin/free-usage", fetcher);
  const [scope, setScope] = useState<Scope>("month");
  const [userScope, setUserScope] = useState<Scope>("month");
  const [userSearch, setUserSearch] = useState("");

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-[10px]">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="rounded-2xl min-h-[96px] animate-pulse" style={cardStyle} />
          ))}
        </div>
        <div className="rounded-2xl animate-pulse" style={{ ...cardStyle, height: 220 }} />
      </div>
    );
  }

  if (error || !data || "error" in data) {
    return (
      <div className="rounded-2xl px-6 py-8 text-center" style={cardStyle}>
        <p className="text-sm font-medium" style={{ color: "var(--c-45)" }}>Free resources usage could not be loaded</p>
        <p className="text-xs mt-1" style={{ color: "var(--c-35)" }}>
          {(data as { error?: string } | undefined)?.error ?? "Refresh to try again"}
        </p>
      </div>
    );
  }

  const totals = scope === "today" ? data.totals.today : scope === "month" ? data.totals.month : data.totals.allTime;
  const monthName = new Date(`${data.month}-01T00:00:00Z`)
    .toLocaleDateString("en", { month: "long", year: "numeric", timeZone: "UTC" });
  const todayName = new Date(`${data.today}T00:00:00Z`)
    .toLocaleDateString("en", { month: "long", day: "numeric", timeZone: "UTC" });
  const nameFor = (v: Scope) => (v === "today" ? `${todayName} (UTC)` : v === "month" ? monthName : "All time");
  const scopeLabel = nameFor(scope);

  const ai33Month = data.totals.month.ai33_tts_chars ?? 0;
  const allocated = data.totals.quotaAllocatedMonth;
  const utilisation = allocated > 0 ? Math.round((ai33Month / allocated) * 100) : null;
  const overQuota = data.users.filter((u) => u.quotaPct !== null && u.quotaPct >= 100);
  const sumOf = (m: Record<string, number>) => Object.values(m).reduce((a, b) => a + b, 0);
  const rowValue = (u: FreeUsageUserRow) => (userScope === "today" ? u.today : userScope === "month" ? u.month : u.allTime);

  // Re-sorted client-side so the order matches the column being read: the
  // endpoint sorts by this month, which looks arbitrary on the all-time view.
  const needle = userSearch.trim().toLowerCase();
  const visibleUsers = data.users
    .filter((u) => !needle
      || u.email.toLowerCase().includes(needle)
      || (u.isAdmin ? "admin" : u.plan).toLowerCase().includes(needle))
    .sort((a, b) => sumOf(rowValue(b)) - sumOf(rowValue(a)));
  const userScopeLabel = nameFor(userScope);

  return (
    <div className="space-y-4">
      {/* Video credits are the newest perk Heclus funds, and the only one whose
          upstream account can run dry mid-render, so its health sits at the top
          of the tab that already covers everything we pay for. */}
      <GenAIProCard />

      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wider mb-1 flex items-center gap-1.5" style={{ color: "oklch(0.50 0 0)" }}>
            <Gift size={12} /> Free resources usage — {scopeLabel}
          </p>
          <p className="text-xs" style={{ color: "var(--c-45)" }}>
            Perks Heclus pays for. Client-funded generation is under Videos → Cost, not here.
          </p>
        </div>
        <div className="flex items-center gap-1 p-0.5 rounded-lg" style={{ background: "oklch(0 0 0 / 0.04)", border: "1px solid oklch(0 0 0 / 0.08)" }}>
          {SCOPES.map(([v, text]) => (
            <button key={v} onClick={() => setScope(v)}
              className="px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer"
              style={scope === v
                ? { background: "var(--bg-elevated)", color: "oklch(0.62 0.15 220)", boxShadow: "0 1px 3px oklch(0 0 0 / 0.06)" }
                : { background: "transparent", color: "var(--c-50)" }}>
              {text}
            </button>
          ))}
        </div>
      </div>

      {/* 1. Overall */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-[10px]">
        {data.activeKinds.filter((k) => (totals[k] ?? 0) > 0 || (data.totals.allTime[k] ?? 0) > 0).map((k) => (
          <Tile key={k} value={compact(totals[k] ?? 0)} suffix={unit(k)} label={label(k)}
            hint={scope === "allTime" ? undefined : `${compact(data.totals.allTime[k] ?? 0)} all time`} />
        ))}
        <Tile
          value={String(scope === "today" ? data.totals.usersToday : scope === "month" ? data.totals.usersMonth : data.totals.usersAllTime)}
          suffix="accounts"
          label="Accounts consuming perks"
          hint={scope === "allTime" ? undefined : `${data.totals.usersAllTime} have ever used one`}
        />
        {utilisation !== null && (
          <Tile value={`${utilisation}%`} label="Allowance used this month"
            hint={`${compact(ai33Month)} of ${compact(allocated)} allocated`}
            tone={utilisation >= 90 ? "#e8745a" : undefined} />
        )}
        {data.estimatedMonthUsd !== null ? (
          <Tile value={`$${data.estimatedMonthUsd.toFixed(2)}`} label="Estimated ai33 cost this month"
            hint={`at $${data.usdPerMillion}/M chars`} />
        ) : (
          <Tile value="—" label="Estimated ai33 cost"
            hint="Set AI33_TTS_USD_PER_MILLION_CHARS to price this" />
        )}
      </div>

      {overQuota.length > 0 && (
        <div className="rounded-xl px-4 py-3 text-xs" style={{ background: "oklch(0.6 0.19 25 / 0.07)", border: "1px solid oklch(0.6 0.19 25 / 0.25)", color: "oklch(0.45 0.15 25)" }}>
          {overQuota.length} account{overQuota.length === 1 ? "" : "s"} at or over the monthly allowance:{" "}
          {overQuota.slice(0, 4).map((u) => u.email).join(", ")}
          {overQuota.length > 4 ? ` and ${overQuota.length - 4} more` : ""}.
        </div>
      )}

      <div className="rounded-2xl p-5" style={cardStyle}>
        <div className="flex items-end justify-between gap-3 mb-3">
          <div>
            <p className="text-sm font-semibold" style={{ color: "var(--c-75)" }}>Characters per day</p>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-40)" }}>Last 30 days</p>
          </div>
          <span className="text-2xl font-semibold tabular-nums" style={{ color: "var(--c-90)" }}>
            {compact(data.daily.reduce((sum, d) => sum + Object.entries(d.byKind)
              .filter(([k]) => unit(k) === "chars")
              .reduce((s, [, v]) => s + v, 0), 0))}
          </span>
        </div>
        <DailyChart daily={data.daily} kinds={data.kinds} />
      </div>

      {/* 2. By user. Its own scope and search rather than inheriting the
          toggle above: reading the overall month while hunting a specific
          account's lifetime usage is a normal thing to want. */}
      <div>
        <div className="flex items-end justify-between flex-wrap gap-3 mb-2">
          <p className="text-xs font-medium uppercase tracking-wider" style={{ color: "oklch(0.50 0 0)" }}>
            Usage by user — {userScopeLabel}
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[200px]">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2" style={{ color: "var(--c-45)" }} />
              <input
                value={userSearch}
                onChange={(e) => setUserSearch(e.target.value)}
                placeholder="Search user or plan…"
                className="w-full sm:w-[340px] lg:w-[420px] pl-7 pr-7 py-1.5 rounded-lg text-xs outline-none transition-all"
                style={{ background: "var(--bg-input)", border: "1px solid var(--bd-8)", color: "var(--c-90)" }}
              />
              {userSearch && (
                <button type="button" onClick={() => setUserSearch("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 transition-opacity hover:opacity-70"
                  style={{ color: "var(--c-45)" }} aria-label="Clear search">
                  <X size={12} />
                </button>
              )}
            </div>
            <div className="flex items-center gap-1 p-0.5 rounded-lg" style={{ background: "oklch(0 0 0 / 0.04)", border: "1px solid oklch(0 0 0 / 0.08)" }}>
              {SCOPES.map(([v, text]) => (
                <button key={v} onClick={() => setUserScope(v)}
                  className="px-2.5 py-1 rounded-md text-xs font-medium transition-all cursor-pointer"
                  style={userScope === v
                    ? { background: "var(--bg-elevated)", color: "oklch(0.62 0.15 220)", boxShadow: "0 1px 3px oklch(0 0 0 / 0.06)" }
                    : { background: "transparent", color: "var(--c-50)" }}>
                  {text}
                </button>
              ))}
            </div>
          </div>
        </div>
        {data.users.length === 0 ? (
          <div className="text-sm py-4 italic" style={{ color: "var(--c-35)" }}>
            No account has used a free resource yet.
          </div>
        ) : visibleUsers.length === 0 ? (
          <div className="text-sm py-4 italic" style={{ color: "var(--c-35)" }}>
            No account matches &ldquo;{userSearch}&rdquo;.
          </div>
        ) : (
          <div className="rounded-2xl overflow-x-auto w-full max-w-full" style={cardStyle}>
            <table className="w-full border-collapse min-w-[720px]">
              <thead>
                <tr style={{ borderBottom: "1px solid var(--bd-7)" }}>
                  {["User", "Plan", ...data.kinds.map(label), "Allowance used", "Last used"].map((h) => (
                    <th key={h} className="text-left py-3 px-4 text-xs font-medium uppercase tracking-wider"
                      style={{ color: "var(--c-40)" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleUsers.map((u) => {
                  const values = rowValue(u);
                  const idle = sumOf(values) === 0;
                  return (
                    <tr key={u.userId} style={{ borderBottom: "1px solid var(--bd-4)", opacity: idle ? 0.55 : 1 }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bd-2)"; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}>
                      <td className="py-3 px-4 text-xs font-mono max-w-[220px]" style={{ color: "var(--c-55)" }}>
                        <span className="truncate block">{u.email}</span>
                      </td>
                      <td className="py-3 px-4 text-xs">
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider"
                          style={{ background: "oklch(0 0 0 / 0.05)", color: "var(--c-50)" }}>
                          {u.isAdmin ? "admin" : u.plan}
                        </span>
                      </td>
                      {data.kinds.map((k) => (
                        <td key={k} className="py-3 px-4 text-xs tabular-nums" style={{ color: (values[k] ?? 0) > 0 ? "var(--c-75)" : "var(--c-25)" }}>
                          {(values[k] ?? 0) > 0 ? compact(values[k]) : "—"}
                        </td>
                      ))}
                      <td className="py-3 px-4 text-xs">
                        {/* Always the monthly figure: the allowance is monthly,
                            so showing an all-time total against it would read
                            as wildly over quota. */}
                        {u.quotaPct === null
                          ? <span style={{ color: "var(--c-25)" }}>no allowance</span>
                          : <QuotaBar used={u.month.ai33_tts_chars ?? 0} quota={u.quota} pct={u.quotaPct} />}
                      </td>
                      <td className="py-3 px-4 text-xs" style={{ color: "var(--c-45)" }}>{u.lastUsed ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
