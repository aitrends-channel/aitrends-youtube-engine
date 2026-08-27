"use client";

import useSWR from "swr";

type DisplayColumn =
  | "channel_analysis"
  | "topic"
  | "script"
  | "visuals"
  | "prompts"
  | "voiceover"
  | "generate"
  | "assemble"
  | "thumbnail";

interface CostBreakdownEntry {
  provider: string;
  model: string | null;
  unitKind: string;
  units: number;
}

interface ColumnSummary {
  totals: Record<string, number>;
  breakdown: CostBreakdownEntry[];
  heclusCredits: number;
  heclusCreditsCharged: number;
}

interface CostResponse {
  projectId: string;
  columns: Record<DisplayColumn, ColumnSummary>;
  /** True when the account spends Heclus Credits. Provider units are then the
   *  wrong unit: they never see a KIE or Anthropic bill, and "kie: 1.7" is a
   *  number from someone else's invoice. */
  inCredits?: boolean;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json() as Promise<CostResponse>);

/** Map every raw unit_kind to one of the four short provider keys
 *  shown on the one-liner. Multiple Claude token-kinds collapse into
 *  a single "ant" entry — surfacing the in/out/cache split inline
 *  would push the chip over multiple lines on small screens. */
const PROVIDER_OF: Record<string, "kie" | "sup" | "ant" | "el"> = {
  kie_credits: "kie",
  supadata_transcripts: "sup",
  claude_tokens_in: "ant",
  claude_tokens_out: "ant",
  claude_tokens_cache_read: "ant",
  claude_tokens_cache_creation: "ant",
  elevenlabs_chars: "el",
};

const PROVIDER_ORDER: Array<"kie" | "sup" | "ant" | "el"> = ["kie", "sup", "ant", "el"];

/** One-liner step usage chip: `Used: kie-X, sup-X, ant-X`.
 *
 *  Aggregates raw unit_kinds into per-provider totals so a step that
 *  bills multiple Claude token-kinds collapses into a single "ant-N"
 *  number. Pulls from /api/projects/[projectId]/costs and refreshes
 *  every 15s for live mid-generation updates. */
export function StepCostCard({ projectId, column, hideUnitKinds }: {
  projectId: string;
  column: DisplayColumn;
  /** Raw unit_kinds to suppress before aggregation. Used on the
   *  channel page to hide Supadata transcripts from non-admins. */
  hideUnitKinds?: string[];
}) {
  // Wizard placeholders like "new" / "new-fork" appear in the URL
  // before a project row exists. The costs route would then run
  // .eq("id", "new") against a uuid column and Postgres throws
  // "invalid input syntax for type uuid" → 500. Skip the fetch until
  // we have a real id.
  const isRealProject = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId);
  const { data } = useSWR<CostResponse>(
    isRealProject ? `/api/projects/${projectId}/costs` : null,
    fetcher,
    {
      refreshInterval: 15_000,
      revalidateOnFocus: false,
    },
  );

  const hidden = new Set(hideUnitKinds ?? []);
  const allColumns = Object.values(data?.columns ?? {}) as ColumnSummary[];

  // The chip is the running total for the video, not this step alone. Someone
  // on the Prompts step wants to know what the video has cost so far, and
  // reading that meant adding up seven chips across seven pages. The per-step
  // figures are unchanged underneath: the API still reports every column
  // separately, and this step's own share is on the hover.
  const rollUp = (summaries: ColumnSummary[]): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const summary of summaries) {
      for (const [unitKind, units] of Object.entries(summary?.totals ?? {})) {
        if (hidden.has(unitKind)) continue;
        if (typeof units !== "number" || units <= 0) continue;
        const provider = PROVIDER_OF[unitKind];
        if (!provider) continue;
        out[provider] = (out[provider] ?? 0) + units;
      }
    }
    return out;
  };

  const byProvider = rollUp(allColumns);
  const thisStep = data?.columns?.[column];

  if (isRealProject && !data) {
    return (
      <span className="inline-block h-[26px] w-32 rounded-md animate-pulse align-middle"
        style={{ background: "oklch(1 0 0 / 0.06)", border: "1px solid oklch(1 0 0 / 0.08)" }} />
    );
  }

  const inCredits = !!data?.inCredits;
  // Charged, and for the whole video. The per-step number is still metered and
  // still returned; it is on the hover rather than in the chip.
  const credits = allColumns.reduce((sum, c) => sum + (c?.heclusCreditsCharged ?? 0), 0);
  const stepCredits = thisStep?.heclusCreditsCharged ?? 0;
  const stepByProvider = rollUp(thisStep ? [thisStep] : []);
  const stepParts = PROVIDER_ORDER
    .filter((key) => (stepByProvider[key] ?? 0) > 0)
    .map((key) => `${key} ${formatProvider(key, stepByProvider[key])}`)
    .join(", ");

  const parts = PROVIDER_ORDER
    .filter((p) => byProvider[p] !== undefined && byProvider[p] > 0)
    .map((p) => ({ key: p, value: formatProvider(p, byProvider[p]) }));

  // Rendered as a subtle status badge — a transparent green tint with
  // a low-opacity border so it reads as a stat indicator (matching the
  // "Free plan" / "Found" pills used elsewhere) rather than a CTA. The
  // earlier solid-green-on-white look was easy to mistake for a button.
  return (
    <span
      className="inline-flex items-center rounded-md overflow-hidden text-xs font-medium break-words max-w-full"
      style={{ border: "1px solid oklch(0.55 0.15 145 / 0.3)" }}
      title={
        inCredits
          ? `Total for this video. This step: ${stepCredits.toLocaleString(undefined, { maximumFractionDigits: 2 })} credits`
          : `Total for this video. This step: ${stepParts || "nothing yet"}`
      }
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
        {inCredits
          ? (credits > 0
            ? `${credits.toLocaleString(undefined, { maximumFractionDigits: 2 })} credits`
            : "—")
          : parts.length === 0 ? "—" : parts.map((p, i) => (
            <span key={p.key}>
              {i > 0 && ", "}
              {p.key}<span style={{ marginRight: "3px" }}>:</span>{p.value}
            </span>
          ))}
      </span>
    </span>
  );
}

function formatProvider(provider: string, units: number): string {
  if (provider === "kie") {
    return units.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  return Math.round(units).toLocaleString();
}
