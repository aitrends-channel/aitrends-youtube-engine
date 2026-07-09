"use client";

import useSWR from "swr";
import type { ApiStatusResult } from "@/app/api/api-status/route";
import { useKieActivityStore } from "@/store/kieActivityStore";

const fetcher = (url: string) => fetch(url).then((r) => r.json() as Promise<ApiStatusResult>);

/** Companion to StepCostCard. Shows remaining balances on the two
 *  providers with queryable quotas — KIE credits and ElevenLabs
 *  characters — as a single one-liner chip: `Available: kie-X, el-X`.
 *
 *  Anthropic and Supadata are intentionally omitted: their consumption
 *  is billed through KIE (or per-request without a user-visible
 *  remaining number), so there's no meaningful "available" figure to
 *  surface. Kie already reflects the pool they draw from.
 *
 *  Same refresh cadence as the profile-dropdown balance rows so mounting
 *  another consumer costs zero extra requests — SWR dedupes the fetch. */
export function StepBalanceCard() {
  // Same gating as KieBalanceRow — pause the poll when no step is
  // doing KIE work so idle-project viewing costs zero /chat/credit
  // and ElevenLabs /user hits.
  const hasActivity = useKieActivityStore((s) => s.hasActivity);
  const { data } = useSWR<ApiStatusResult>(
    "/api/api-status",
    fetcher,
    { refreshInterval: hasActivity ? 30_000 : 0, revalidateOnFocus: false },
  );

  const kie = data?.kie?.credits;
  const el  = data?.elevenlabs?.remaining;

  // Both providers are always rendered, even before data lands / when
  // the user hasn't configured a key — an em dash stands in for the
  // number. Users asked for a stable shape on every step so the badge
  // width doesn't jump around and they can always see at a glance
  // which provider a `—` refers to.
  const parts: Array<{ key: string; value: string }> = [
    { key: "kie", value: typeof kie === "number" ? kie.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "—" },
    { key: "el",  value: typeof el  === "number" ? el.toLocaleString() : "—" },
  ];

  // Empty balance → orange tint so it reads as a warning, matching the
  // KieBalanceRow low-balance treatment. Otherwise use the muted blue
  // tint so it's visually distinct from the green Used chip alongside.
  const isEmpty = (typeof kie === "number" && kie <= 0) || (typeof el === "number" && el <= 0);
  const labelBg   = isEmpty ? "oklch(0.70 0.18 45)"        : "oklch(0.55 0.15 240)";
  const bodyBg    = isEmpty ? "oklch(0.70 0.18 45 / 0.12)" : "oklch(0.55 0.15 240 / 0.12)";
  const bodyColor = isEmpty ? "oklch(0.60 0.18 45)"        : "oklch(0.55 0.15 240)";
  const borderCol = isEmpty ? "oklch(0.70 0.18 45 / 0.3)"  : "oklch(0.55 0.15 240 / 0.3)";

  return (
    <span
      className="inline-flex items-center rounded-md overflow-hidden text-xs font-medium break-words max-w-full"
      style={{ border: `1px solid ${borderCol}` }}
    >
      <span
        className="uppercase tracking-wider px-2 py-1"
        style={{ fontSize: "10px", background: labelBg, color: "oklch(1 0 0)" }}
      >
        Available
      </span>
      <span
        className="tabular-nums px-2.5 py-1"
        style={{ background: bodyBg, color: bodyColor }}
      >
        {parts.map((p, i) => (
          <span key={p.key}>
            {i > 0 && ", "}
            {p.key}<span style={{ marginRight: "3px" }}>:</span>{p.value}
          </span>
        ))}
      </span>
    </span>
  );
}
