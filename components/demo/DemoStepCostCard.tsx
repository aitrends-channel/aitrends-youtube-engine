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
  const kie = DEMO_DATA.costs[column]?.kie ?? 0;
  const formatted = kie > 0
    ? kie.toLocaleString(undefined, { maximumFractionDigits: 2 })
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
        {kie > 0 ? (
          <>
            <span>Kie:</span>
            <span style={{ marginLeft: "5px" }}>{formatted}</span>
          </>
        ) : "—"}
      </span>
    </span>
  );
}
