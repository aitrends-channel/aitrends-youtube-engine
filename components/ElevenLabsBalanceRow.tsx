"use client";

import useSWR from "swr";
import { ExternalLink } from "lucide-react";
import type { ApiStatusResult } from "@/app/api/api-status/route";
import { useKieActivityStore } from "@/store/kieActivityStore";

const fetcher = (url: string) =>
  fetch(url).then((r) => r.ok ? r.json() : Promise.reject(r.status));

// Compact rendering for ElevenLabs' character counts — typical Free
// tier is 10K chars, Starter is 30K, Creator is 100K, Pro is 500K, etc.
// Showing raw numbers like "478,231 characters" is noisy in a dropdown;
// k / M suffixes are easier to scan.
function formatChars(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}K`;
  return n.toLocaleString();
}

export function ElevenLabsBalanceRow() {
  // The api-status endpoint checks both KIE credit AND ElevenLabs
  // quota in one call, so we share the same gating signal — polls
  // pause when no step is actively doing generation work.
  const hasActivity = useKieActivityStore((s) => s.hasActivity);
  const { data, isLoading } = useSWR<ApiStatusResult>(
    "/api/api-status",
    fetcher,
    { revalidateOnFocus: false, refreshInterval: hasActivity ? 30_000 : 0 },
  );
  // Nothing to report for a wallet-funded account: the voiceover runs on
  // Heclus's ElevenLabs account, so its character count is not the customer's
  // to read or to top up. The Heclus Credits row above is the balance that
  // applies, and this row hides rather than showing a dash forever.
  if (data?.fundingMode === "wallet") return null;

  const el = data?.elevenlabs;
  const remaining = el?.remaining;
  const limit = el?.limit;
  const hasNumber = typeof remaining === "number";

  // Distinguish four states so the UI tells the user WHY a balance
  // isn't showing instead of just blank-dashing them:
  //   loading      — fetch in flight, no data yet
  //   not-configured — no key set in account_settings or env
  //   invalid      — key present but ElevenLabs rejected it (401/403)
  //   unknown      — key OK, API responded but didn't include the
  //                  expected character_count / character_limit (rare)
  //   ok           — balance number to render
  type State = "loading" | "not-configured" | "invalid" | "unknown" | "ok";
  let state: State;
  if (isLoading && !el) state = "loading";
  else if (!el || el.configured === false) state = "not-configured";
  else if (el.valid === false) state = "invalid";
  else if (!hasNumber) state = "unknown";
  else state = "ok";

  const ratio = hasNumber && typeof limit === "number" && limit > 0 ? remaining / limit : null;
  // state === "ok" implies hasNumber === true, but TS can't follow
  // that across the chained derivation above. Assert non-null here.
  const valueColor = state === "ok"
    ? remaining! <= 0
      ? "oklch(0.7 0.18 25)"
      : ratio !== null && ratio < 0.05
        ? "oklch(0.72 0.18 65)"
        : "var(--c-88)"
    : state === "invalid"
      ? "oklch(0.7 0.18 25)"
      : "var(--c-50)";

  const valueText =
    state === "loading" ? "Loading…" :
    state === "not-configured" ? "No key set" :
    state === "invalid" ? "Invalid key" :
    state === "unknown" ? "Unknown" :
    `${formatChars(remaining!)} chars`;

  return (
    <div
      className="px-4 py-3"
      style={{ borderBottom: "1px solid var(--bd-7)" }}
    >
      <div className="flex items-center justify-between mb-1">
        <span
          className="text-[10px] uppercase tracking-wider font-semibold"
          style={{ color: "var(--c-50)" }}
        >
          ElevenLabs balance
        </span>
        <a
          href={state === "not-configured" || state === "invalid" ? "/setup" : "https://elevenlabs.io/app/subscription"}
          target={state === "not-configured" || state === "invalid" ? undefined : "_blank"}
          rel={state === "not-configured" || state === "invalid" ? undefined : "noopener noreferrer"}
          className="text-[10px] flex items-center gap-1 hover:opacity-80 transition-opacity"
          style={{ color: "var(--c-45)" }}
        >
          {state === "not-configured" ? "Add key" : state === "invalid" ? "Fix key" : "Top up"}
          <ExternalLink size={9} />
        </a>
      </div>
      <p className="text-sm font-bold" style={{ color: valueColor }}>
        {valueText}
      </p>
      {state === "ok" && hasNumber && remaining! <= 0 && (
        <p className="text-[10px] mt-1" style={{ color: "oklch(0.7 0.18 25)" }}>
          Voiceover generation will fail until topped up.
        </p>
      )}
      {state === "invalid" && (
        <p className="text-[10px] mt-1" style={{ color: "oklch(0.7 0.18 25)" }}>
          ElevenLabs rejected the key. Update it in Setup.
        </p>
      )}
    </div>
  );
}
