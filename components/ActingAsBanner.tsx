"use client";

import useSWR from "swr";
import { useState } from "react";
import type { ActingAsStatus } from "@/app/api/admin/act-as/route";

const fetcher = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : { actingAs: null }));

// Says whose account you are in.
//
// Not decoration. While this is up, every action is the customer's: their
// credits pay for a generation, their rows change, and nothing is sandboxed.
// An admin who forgets which tab they are in spends someone else's money, so
// this is fixed to the top of the viewport rather than sitting in a panel that
// can scroll away.
export function ActingAsBanner() {
  const { data, mutate } = useSWR<ActingAsStatus>("/api/admin/act-as", fetcher, {
    revalidateOnFocus: true,
  });
  const [stopping, setStopping] = useState(false);
  const target = data?.actingAs;
  if (!target) return null;

  async function stop() {
    setStopping(true);
    try {
      await fetch("/api/admin/act-as", { method: "DELETE" });
      await mutate();
      // Reloaded rather than re-rendered: every panel on the page was fetched
      // as the customer and would otherwise keep showing their data under the
      // admin's own name, which is the confusion this banner exists to prevent.
      window.location.reload();
    } finally {
      setStopping(false);
    }
  }

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[100] flex items-center justify-center gap-3 px-4 py-1.5 text-xs font-semibold"
      style={{ background: "oklch(0.72 0.18 65)", color: "oklch(0.16 0 0)" }}
    >
      <span>
        Acting as <span className="font-bold">{target.email}</span>. Their credits and their data.
      </span>
      <button
        type="button"
        onClick={stop}
        disabled={stopping}
        className="px-2 py-0.5 rounded-md font-bold transition-opacity hover:opacity-80 disabled:opacity-50 cursor-pointer"
        style={{ background: "oklch(0.16 0 0)", color: "oklch(0.72 0.18 65)" }}
      >
        {stopping ? "Stopping…" : "Stop"}
      </button>
    </div>
  );
}
