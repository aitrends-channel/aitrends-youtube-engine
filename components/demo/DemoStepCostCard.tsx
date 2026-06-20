"use client";

import { DEMO_DATA } from "@/lib/demo-data";

// Visual + naming twin of the real StepCostCard, but driven by static
// values in DEMO_DATA.costs instead of the live /api/projects/.../costs
// route. Same column-keying convention so swapping the import is the
// only thing a demo page has to do.
export type DemoCostColumn = keyof typeof DEMO_DATA.costs;

const PROVIDER_ORDER: Array<"kie" | "sup" | "ant" | "el"> = ["kie", "sup", "ant", "el"];

function formatProvider(provider: string, units: number): string {
  if (provider === "kie") {
    return units.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return Math.round(units).toLocaleString();
}

export function DemoStepCostCard({ column }: { column: DemoCostColumn }) {
  const totals = DEMO_DATA.costs[column] as Partial<Record<"kie" | "sup" | "ant" | "el", number>>;

  const parts = PROVIDER_ORDER
    .filter((p) => (totals[p] ?? 0) > 0)
    .map((p) => `${p}-${formatProvider(p, totals[p] as number)}`);

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
        {parts.length === 0 ? "—" : parts.join(", ")}
      </span>
    </span>
  );
}
