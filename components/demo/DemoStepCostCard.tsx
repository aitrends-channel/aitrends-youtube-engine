"use client";

import { DEMO_DATA } from "@/lib/demo-data";

// Visual twin of the real StepCostCard, but the demo intentionally
// surfaces only the unified KIE-credit total per step (no per-provider
// breakdown). Underlying Claude / Supadata / ElevenLabs costs are
// represented as KIE credits in the dashboard the user actually gets
// billed against, so showing them separately here would over-expose
// internals that don't matter to a demo viewer.
export type DemoCostColumn = keyof typeof DEMO_DATA.costs;

export function DemoStepCostCard({ column }: { column: DemoCostColumn }) {
  const entry = DEMO_DATA.costs[column] as { kie?: number; el?: number };
  const kie = entry?.kie ?? 0;
  const el = entry?.el ?? 0;
  const kieDisplay = kie > 0
    ? kie.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : "—";
  const elDisplay = el > 0
    ? Math.round(el).toLocaleString()
    : "—";

  return (
    <span
      className="inline-flex items-center rounded-md overflow-hidden text-xs font-medium break-words max-w-full"
      style={{ border: "1px solid oklch(0.55 0.15 145 / 0.3)" }}
    >
      <span
        className="uppercase tracking-wider px-2 py-1"
        style={{
          fontSize: "10px",
          background: "oklch(0.55 0.15 145)",
          color: "oklch(1 0 0)",
        }}
      >
        Used
      </span>
      <span
        className="tabular-nums px-2.5 py-1"
        style={{
          background: "oklch(0.55 0.15 145 / 0.12)",
          color: "oklch(0.7 0.15 145)",
        }}
      >
        <span>Kie:</span>
        <span style={{ marginLeft: "5px" }}>{kieDisplay}</span>
        <span style={{ margin: "0 6px" }}>·</span>
        <span>El:</span>
        <span style={{ marginLeft: "5px" }}>{elDisplay}</span>
      </span>
    </span>
  );
}
