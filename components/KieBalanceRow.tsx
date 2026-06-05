"use client";

import useSWR from "swr";
import { ExternalLink } from "lucide-react";
import type { ApiStatusResult } from "@/app/api/api-status/route";

const fetcher = (url: string) =>
  fetch(url).then((r) => r.ok ? r.json() : Promise.reject(r.status));

// Persistent KIE credit balance for the profile dropdowns. Same data
// source as the generate page's inline balance — SWR dedupes the fetch
// across mounted components so showing it in multiple places costs one
// request per refresh interval, not one per consumer.
export function KieBalanceRow() {
  const { data, isLoading } = useSWR<ApiStatusResult>(
    "/api/api-status",
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 30_000 }
  );
  const credits = data?.kie?.credits;
  const hasNumber = typeof credits === "number";
  const color = hasNumber
    ? credits <= 0
      ? "oklch(0.7 0.18 25)"
      : credits < 100
        ? "oklch(0.72 0.18 65)"
        : "var(--c-88)"
    : "var(--c-50)";

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
          KIE balance
        </span>
        <a
          href="https://kie.ai/billing"
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] flex items-center gap-1 hover:opacity-80 transition-opacity"
          style={{ color: "var(--c-45)" }}
        >
          Top up
          <ExternalLink size={9} />
        </a>
      </div>
      <p className="text-sm font-bold" style={{ color }}>
        {isLoading && !hasNumber
          ? "Loading…"
          : hasNumber
            ? `${credits.toLocaleString()} credit${credits === 1 ? "" : "s"}`
            : "—"}
      </p>
      {hasNumber && credits <= 0 && (
        <p className="text-[10px] mt-1" style={{ color: "oklch(0.7 0.18 25)" }}>
          Generation will fail until topped up.
        </p>
      )}
    </div>
  );
}
