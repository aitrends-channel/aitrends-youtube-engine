"use client";

import { useState } from "react";
import useSWR from "swr";
import type { DrawdownReport } from "@/app/api/admin/provider-drawdown/route";

const fetcher = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));

const cr = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 1 });
const pct = (n: number) => `${n > 0 ? "+" : ""}${(n * 100).toFixed(0)}%`;

// Did the provider accounts fall by what we recorded spending?
//
// The rate-drift card above answers "is the price right", which needs an
// invoice. KIE issues none and publishes no price list, so it has no row there
// at all. This answers the other question, which needs neither: the account
// balance fell by some amount, our ledger says we spent some amount, and those
// two numbers come from different places and must agree. A gap is spend nobody
// recorded, which is the wallet under-billing rather than mispricing.
//
// Reads the hourly balance series, so it says nothing useful on day one and says
// something worth acting on after a week. That is stated rather than hidden
// behind an empty table.
export function ProviderDrawdownCard() {
  const { data, isLoading, mutate } = useSWR<DrawdownReport>(
    "/api/admin/provider-drawdown",
    fetcher,
    { revalidateOnFocus: false },
  );

  const [provider, setProvider] = useState("kie");
  const [credits, setCredits] = useState("");
  const [usdPaid, setUsdPaid] = useState("");
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const detected = data?.detectedTopUps.find((t) => t.provider === provider);

  async function confirmPrice() {
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/provider-drawdown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, credits, usdPaid }),
      });
      const body = await res.json() as { error?: string; usdPerCredit?: number; action?: string };
      setResult(body.error
        ? body.error
        : `$${(body.usdPerCredit ?? 0).toFixed(5)} a credit. ${body.action ?? ""}`);
      if (!body.error) { setCredits(""); setUsdPaid(""); await mutate(); }
    } catch {
      setResult("Could not save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="rounded-2xl w-full max-w-full p-4 space-y-3"
      style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.10)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}
    >
      <div>
        <p className="text-xs uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Provider drawdown</p>
        <p className="text-sm" style={{ color: "var(--c-50)" }}>
          What the KIE and PoYo accounts actually lost, against what our ledger recorded spending. A gap is a charge
          nobody wrote down. This is the only check KIE has, since it issues no invoice and publishes no price list.
        </p>
      </div>

      {isLoading && <p className="text-xs" style={{ color: "var(--c-45)" }}>Loading…</p>}

      {data && !data.schema && (
        <p className="text-xs" style={{ color: "oklch(0.6 0.22 25)" }}>
          Migration 141_provider_balances.sql is not applied, so nothing is being recorded yet.
        </p>
      )}

      {data && (
        <div className="flex flex-wrap gap-3 text-xs">
          {data.balances.map((b) => (
            <span key={b.provider} className="px-2 py-1 rounded-lg tabular-nums"
              style={{ background: "oklch(0 0 0 / 0.04)", color: b.credits === null ? "oklch(0.6 0.22 25)" : "var(--c-70)" }}>
              {b.provider} balance {b.credits === null ? (b.problem ?? "unreadable") : cr(b.credits)}
            </span>
          ))}
        </div>
      )}

      {data && data.findings.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs" style={{ color: "var(--c-70)" }}>
            <thead>
              <tr style={{ color: "var(--c-40)" }}>
                <th className="text-left font-medium py-1">Provider</th>
                <th className="text-right font-medium py-1">Account fell</th>
                <th className="text-right font-medium py-1">Ledger recorded</th>
                <th className="text-right font-medium py-1">Unaccounted</th>
                <th className="text-right font-medium py-1">Topped up</th>
                <th className="text-right font-medium py-1">Snapshots</th>
              </tr>
            </thead>
            <tbody>
              {data.findings.map((f) => {
                const flagged = data.meaningful.includes(f.provider);
                return (
                  <tr key={f.provider} style={{ borderTop: "1px solid oklch(0 0 0 / 0.06)" }}>
                    <td className="py-1.5 pr-3">{f.provider}</td>
                    <td className="py-1.5 text-right tabular-nums">{cr(f.observedSpend)}</td>
                    <td className="py-1.5 text-right tabular-nums">{cr(f.recordedSpend)}</td>
                    <td className="py-1.5 text-right tabular-nums font-semibold"
                      // Red only when the account lost more than we recorded.
                      // The other direction is a snapshot boundary, not a leak.
                      style={{ color: !flagged ? "var(--c-45)" : f.gap > 0 ? "oklch(0.6 0.22 25)" : "oklch(0.55 0.15 145)" }}>
                      {cr(f.gap)} <span className="font-normal">({pct(f.gapShare)})</span>
                    </td>
                    <td className="py-1.5 text-right tabular-nums" style={{ color: "var(--c-40)" }}>{cr(f.toppedUp)}</td>
                    <td className="py-1.5 text-right tabular-nums" style={{ color: "var(--c-40)" }}>{f.snapshots}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-[11px] mt-2" style={{ color: "var(--c-40)" }}>
            Only drops count as spend, so a top-up cannot paper over a month of unrecorded charges. The account is
            shared by every user, so a gap says the total is off and not which beat leaked it: for that, look for
            tasks with an id and no terminal state on the Jobs tab.
          </p>
        </div>
      )}

      {data && data.problems.length > 0 && (
        <ul className="text-[11px] space-y-1" style={{ color: "var(--c-45)" }}>
          {data.problems.map((p, i) => <li key={i}>{p}</li>)}
        </ul>
      )}

      <div className="pt-2 space-y-2" style={{ borderTop: "1px solid oklch(0 0 0 / 0.08)" }}>
        <div>
          <p className="text-xs font-semibold" style={{ color: "var(--c-70)" }}>What a credit costs</p>
          <p className="text-[11px]" style={{ color: "var(--c-45)" }}>
            The wallet converts every provider credit at ${data?.billedUsdPerCredit ?? 0.005}, and no API reports
            whether that is still right. A top-up receipt is the only thing that can confirm it: enter what you paid
            and the rate follows.
          </p>
        </div>

        {data && data.prices.length > 0 && (
          <div className="flex flex-wrap gap-2 text-[11px]">
            {data.prices.map((p) => {
              const drift = p.usdPerCredit / (data.billedUsdPerCredit || 1) - 1;
              const stale = p.ageDays > 90;
              return (
                <span key={p.provider} className="px-2 py-1 rounded-lg tabular-nums"
                  style={{
                    background: "oklch(0 0 0 / 0.04)",
                    color: Math.abs(drift) >= 0.02 ? "oklch(0.6 0.22 25)" : stale ? "oklch(0.58 0.14 70)" : "var(--c-70)",
                  }}>
                  {p.provider} ${p.usdPerCredit.toFixed(5)} a credit
                  {Math.abs(drift) >= 0.02 ? ` (${pct(drift)} vs billed)` : ""}
                  {` · confirmed ${p.ageDays} day${p.ageDays === 1 ? "" : "s"} ago`}
                </span>
              );
            })}
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2">
          <div>
            <label className="text-[11px] block" style={{ color: "var(--c-45)" }}>Provider</label>
            <select value={provider} onChange={(e) => setProvider(e.target.value)}
              className="mt-1 px-2 py-1.5 rounded-lg text-xs outline-none"
              style={{ background: "oklch(0 0 0 / 0.04)", color: "var(--c-80)" }}>
              <option value="kie">kie</option>
              <option value="poyo">poyo</option>
            </select>
          </div>
          <div>
            <label className="text-[11px] block" style={{ color: "var(--c-45)" }}>Credits added</label>
            <input type="number" min={1} step="any" value={credits}
              onChange={(e) => setCredits(e.target.value)}
              placeholder={detected ? cr(detected.credits) : ""}
              className="w-32 mt-1 px-2 py-1.5 rounded-lg text-xs outline-none tabular-nums"
              style={{ background: "oklch(0 0 0 / 0.04)", color: "var(--c-80)" }} />
          </div>
          <div>
            <label className="text-[11px] block" style={{ color: "var(--c-45)" }}>Dollars paid</label>
            <input type="number" min={0} step="any" value={usdPaid}
              onChange={(e) => setUsdPaid(e.target.value)}
              className="w-28 mt-1 px-2 py-1.5 rounded-lg text-xs outline-none tabular-nums"
              style={{ background: "oklch(0 0 0 / 0.04)", color: "var(--c-80)" }} />
          </div>
          <button type="button" onClick={confirmPrice}
            disabled={saving || !credits.trim() || !usdPaid.trim()}
            className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-40"
            style={{ background: "oklch(0.72 0.25 285)", color: "white" }}>
            {saving ? "Saving…" : "Confirm price"}
          </button>
        </div>

        {detected && (
          <p className="text-[11px]" style={{ color: "var(--c-40)" }}>
            The {provider} balance rose by {cr(detected.credits)} on{" "}
            {new Date(detected.at).toLocaleDateString()}, which is the largest rise recorded in 60 days. That is
            almost certainly the top-up, so it is offered as the credits figure.
          </p>
        )}

        {result && <p className="text-[11px]" style={{ color: "var(--c-60)" }}>{result}</p>}
      </div>
    </div>
  );
}
