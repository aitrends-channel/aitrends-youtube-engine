"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
import { ListFilter } from "lucide-react";
import type { LedgerPage } from "@/app/api/heclus-credits/ledger/route";

const fetcher = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));

// What used the credits, in the customer's terms.
//
// The panel above answers "how many are left"; this answers "on what", which is
// the question asked when the answer is low. Rows are keyed to the project and
// beat they came from and the project is named and linked, so a row leads back
// to the work rather than to a provider task id nobody recognises.

const KINDS = [
  { value: "", label: "All activity" },
  { value: "spend", label: "Spent" },
  { value: "topup", label: "Purchased" },
  { value: "refund", label: "Refunded" },
  { value: "adjustment", label: "Adjusted" },
];

function labelFor(kind: string, provider: string | null) {
  switch (kind) {
    case "topup":      return "Credits purchased";
    case "refund":     return "Refunded";
    case "adjustment": return "Adjusted by Heclus";
    default:           return provider ? `Spent on ${provider}` : "Spent";
  }
}

export function CreditActivity() {
  const [kind, setKind] = useState("");
  const [provider, setProvider] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(0);

  const query = new URLSearchParams({
    page: String(page),
    ...(kind ? { kind } : {}),
    ...(provider ? { provider } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  });
  const { data, isLoading } = useSWR<LedgerPage>(
    `/api/heclus-credits/ledger?${query}`, fetcher, { revalidateOnFocus: false, keepPreviousData: true },
  );

  // Any filter change invalidates the page number: page 3 of an unfiltered
  // history is usually past the end of a filtered one, which reads as "no
  // activity" when there is plenty.
  const reset = <T,>(set: (v: T) => void) => (v: T) => { set(v); setPage(0); };

  // The server sends the provider list on the first page only, so the dropdown
  // would empty itself the moment you paged. Held here instead.
  const providersRef = useRef<string[]>([]);
  useEffect(() => {
    if (data?.providers?.length) providersRef.current = data.providers;
  }, [data?.providers]);
  const providers = data?.providers?.length ? data.providers : providersRef.current;

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pageSize = data?.pageSize ?? 25;
  const lastPage = Math.max(0, Math.ceil(total / pageSize) - 1);

  const selectCls = "px-3 py-2 rounded-xl text-sm bg-transparent";
  const selectStyle = { border: "1px solid var(--bd-8)", color: "var(--c-70)" };

  return (
    <div className="p-5 rounded-2xl space-y-4"
      style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" }}>
      <div className="flex items-center gap-3">
        <ListFilter size={16} style={{ color: "var(--c-45)" }} />
        <div>
          <h2 className="text-xl font-bold text-foreground">Credit activity</h2>
          <p className="text-sm mt-0.5" style={{ color: "var(--c-45)" }}>
            Every movement on your Heclus Credits, newest first.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <select value={kind} onChange={(e) => reset(setKind)(e.target.value)} className={selectCls} style={selectStyle}>
          {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
        </select>
        <select value={provider} onChange={(e) => reset(setProvider)(e.target.value)} className={selectCls} style={selectStyle}>
          <option value="">All providers</option>
          {providers.map((p) => <option key={p} value={p}>{p}</option>)}
        </select>
        <input type="date" value={from} onChange={(e) => reset(setFrom)(e.target.value)}
          title="From" className={selectCls} style={selectStyle} />
        <input type="date" value={to} onChange={(e) => reset(setTo)(e.target.value)}
          title="To" className={selectCls} style={selectStyle} />
        {(kind || provider || from || to) && (
          <button type="button" className="px-3 py-2 rounded-xl text-sm transition-all hover:opacity-80"
            style={{ color: "var(--c-45)" }}
            onClick={() => { setKind(""); setProvider(""); setFrom(""); setTo(""); setPage(0); }}>
            Clear
          </button>
        )}
      </div>

      {isLoading && rows.length === 0 ? (
        <p className="text-sm py-8 text-center" style={{ color: "var(--c-45)" }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm py-8 text-center" style={{ color: "var(--c-45)" }}>
          {kind || provider || from || to ? "Nothing matches those filters." : "No activity yet."}
        </p>
      ) : (
        <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--bd-8)" }}>
          {/* Scrolls in its own container: the page must not scroll sideways on a
              narrow screen just because this table is wide. */}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ borderBottom: "1px solid var(--bd-8)" }}>
                  {["When", "What", "Project", "Credits"].map((h, i) => (
                    <th key={h} className={`px-4 py-2.5 text-xs font-semibold ${i === 3 ? "text-right" : "text-left"}`}
                      style={{ color: "var(--c-55)" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} style={{ borderTop: "1px solid var(--bd-6)" }}>
                    <td className="px-4 py-3 whitespace-nowrap" style={{ color: "var(--c-60)" }}>
                      {new Date(r.createdAt).toLocaleString(undefined, {
                        day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
                      })}
                    </td>
                    <td className="px-4 py-3" style={{ color: "var(--c-75)" }}>
                      {labelFor(r.kind, r.provider)}
                      {r.note && <span className="block text-xs" style={{ color: "var(--c-42)" }}>{r.note}</span>}
                    </td>
                    <td className="px-4 py-3">
                      {r.projectId ? (
                        <Link href={`/projects/${r.projectId}`} className="hover:opacity-80 transition-opacity"
                          style={{ color: "oklch(0.72 0.25 285)" }}>
                          {r.projectLabel}
                          {r.beatNumber !== null && (
                            <span style={{ color: "var(--c-42)" }}> · beat {r.beatNumber}</span>
                          )}
                        </Link>
                      ) : (
                        <span style={{ color: "var(--c-35)" }}>—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold tabular-nums whitespace-nowrap"
                      style={{ color: r.credits > 0 ? "oklch(0.7 0.15 145)" : "var(--c-60)" }}>
                      {r.credits > 0 ? "+" : ""}
                      {r.credits.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {total > pageSize && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs" style={{ color: "var(--c-45)" }}>
            {page * pageSize + 1} to {Math.min((page + 1) * pageSize, total)} of {total}
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-80 disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ border: "1px solid var(--bd-8)", color: "var(--c-70)" }}>
              Previous
            </button>
            <button type="button" onClick={() => setPage((p) => Math.min(lastPage, p + 1))} disabled={page >= lastPage}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-80 disabled:opacity-30 disabled:cursor-not-allowed"
              style={{ border: "1px solid var(--bd-8)", color: "var(--c-70)" }}>
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
