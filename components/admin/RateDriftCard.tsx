"use client";

import { useState } from "react";
import useSWR from "swr";
import type { RateReconciliation } from "@/lib/rates/reconcile";

const fetcher = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));

const pct = (n: number) => `${n > 0 ? "+" : ""}${(n * 100).toFixed(0)}%`;
const usd = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

// What we bill against what the providers invoiced.
//
// Reads the stored report rather than running the comparison: the monthly cron
// writes it, and re-billing two org APIs on every admin page load would be a
// poor trade for a number that moves a few times a year. The button forces a
// fresh run for the case that matters — someone has just edited a rate and
// wants to see whether it lands.
export function RateDriftCard() {
  const { data, isLoading, mutate } = useSWR<{ report: RateReconciliation | null }>(
    "/api/admin/rate-drift",
    fetcher,
    { revalidateOnFocus: false },
  );
  const [running, setRunning] = useState(false);

  async function runNow() {
    setRunning(true);
    try {
      const res = await fetch("/api/admin/rate-drift", { method: "POST" });
      const body = (await res.json()) as { report?: RateReconciliation };
      if (body.report) await mutate({ report: body.report }, { revalidate: false });
    } catch {
      // The panel keeps showing the stored report; a failed refresh is not
      // worth an error state of its own.
    } finally {
      setRunning(false);
    }
  }

  const report = data?.report ?? null;

  return (
    <div
      className="rounded-2xl w-full max-w-full p-4 space-y-3"
      style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.10)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}
    >
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Rate drift</p>
          <p className="text-sm" style={{ color: "var(--c-50)" }}>
            What we bill, against what Anthropic and ElevenLabs actually invoiced. Checked monthly.
          </p>
        </div>
        <button
          type="button"
          onClick={runNow}
          disabled={running}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-60"
          style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
        >
          {running ? "Checking…" : "Check now"}
        </button>
      </div>

      {isLoading && <p className="text-xs" style={{ color: "var(--c-45)" }}>Loading…</p>}

      {!isLoading && !report && (
        <p className="text-xs" style={{ color: "var(--c-45)" }}>
          Never run. It needs an Anthropic org admin key, which is not the key the app generates with:
          set ANTHROPIC_ADMIN_KEY, or add one under service anthropic_admin_key.
        </p>
      )}

      {report && (
        <>
          <p className="text-[11px]" style={{ color: "var(--c-40)" }}>
            {new Date(report.from).toLocaleDateString()} to {new Date(report.to).toLocaleDateString()},
            checked {new Date(report.at).toLocaleString()}
          </p>

          {report.findings.length === 0 ? (
            <p className="text-xs" style={{ color: "var(--c-45)" }}>
              Nothing to compare in this window.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs" style={{ color: "var(--c-70)" }}>
                <thead>
                  <tr style={{ color: "var(--c-40)" }}>
                    <th className="text-left font-medium py-1">Model</th>
                    <th className="text-left font-medium py-1">Kind</th>
                    <th className="text-right font-medium py-1">We bill</th>
                    <th className="text-right font-medium py-1">Invoiced</th>
                    <th className="text-right font-medium py-1">Drift</th>
                    <th className="text-right font-medium py-1">Volume</th>
                  </tr>
                </thead>
                <tbody>
                  {report.findings.map((f) => {
                    const off = Math.abs(f.drift) >= 0.05;
                    return (
                      <tr key={`${f.provider}-${f.model}-${f.kind}`} style={{ borderTop: "1px solid oklch(0 0 0 / 0.06)" }}>
                        <td className="py-1.5 pr-3">{f.model}</td>
                        <td className="py-1.5 pr-3" style={{ color: "var(--c-45)" }}>{f.kind.replace("_", " ")}</td>
                        <td className="py-1.5 text-right tabular-nums">{usd(f.tableUsd)}</td>
                        <td className="py-1.5 text-right tabular-nums">{usd(f.actualUsd)}</td>
                        <td
                          className="py-1.5 text-right tabular-nums font-semibold"
                          // Red only when the provider costs more than we bill:
                          // that is the direction that loses money.
                          style={{ color: !off ? "var(--c-45)" : f.drift > 0 ? "oklch(0.6 0.22 25)" : "oklch(0.55 0.15 145)" }}
                        >
                          {pct(f.drift)}
                        </td>
                        <td className="py-1.5 text-right tabular-nums" style={{ color: "var(--c-40)" }}>
                          {f.units.toLocaleString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="text-[11px] mt-2" style={{ color: "var(--c-40)" }}>
                Rates are {report.findings[0]?.unit ?? "per unit"} unless the row says otherwise. ElevenLabs is the
                blended plan rate, invoice over characters spoken, so it is indicative rather than a per-model price.
              </p>
            </div>
          )}

          {report.drifted.length > 0 && (
            <p className="text-xs" style={{ color: "oklch(0.6 0.22 25)" }}>
              {report.drifted.length} rate{report.drifted.length === 1 ? "" : "s"} moved by 5% or more. Edit
              CLAUDE_MODEL_PRICING, or override in credit_rates.claudeModelUsd to take effect without a deploy.
            </p>
          )}

          {report.problems.map((p) => (
            <p key={p} className="text-[11px]" style={{ color: "var(--c-45)" }}>{p}</p>
          ))}
        </>
      )}
    </div>
  );
}
