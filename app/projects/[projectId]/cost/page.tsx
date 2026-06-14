"use client";

import useSWR from "swr";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { WizardNav } from "@/components/wizard/WizardNav";
import { useProject } from "@/hooks/useProject";

interface PageProps {
  params: { projectId: string };
}

// Same display helpers the admin Cost view uses. Kept inline here to
// avoid a refactor that touches the (already large) admin page in the
// same change — if a third surface needs the same logic, lift these
// into lib/cost-display.ts and import from both places.
function compactNumber(n: number): string {
  if (n === 0) return "0";
  if (n < 10 && !Number.isInteger(n)) return n.toFixed(1).replace(/\.0$/, "");
  if (n < 1000) return Math.round(n).toString();
  if (n < 1_000_000) {
    const k = n / 1000;
    return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, "")}k`;
  }
  const m = n / 1_000_000;
  return m >= 100 ? `${Math.round(m)}M` : `${m.toFixed(1).replace(/\.0$/, "")}M`;
}

function unitSuffix(unitKind: string): string {
  switch (unitKind) {
    // "claude_tokens" is the collapsed bucket we build in renderBucket
    // by merging all four claude_tokens_* sub-kinds together; the four
    // sub-kinds themselves still appear here as a belt-and-suspenders
    // fallback in case the bucket key changes upstream.
    case "claude_tokens":
    case "claude_tokens_in":
    case "claude_tokens_out":
    case "claude_tokens_cache_read":
    case "claude_tokens_cache_creation":
      return "tok";
    case "kie_credits":          return "cr";
    case "elevenlabs_chars":     return "chr";
    case "supadata_transcripts": return "tx";
    default:                     return unitKind;
  }
}

type CostBreakdownEntry = {
  provider: string;
  model: string | null;
  unitKind: string;
  units: number;
};

type ColumnSummary = {
  totals: Record<string, number>;
  breakdown: CostBreakdownEntry[];
};

type CostColumn =
  | "channel_analysis" | "topic" | "script" | "visuals"
  | "prompts" | "voiceover" | "generate" | "assemble" | "thumbnail";

type CostsResponse = {
  projectId: string;
  columns: Record<CostColumn, ColumnSummary>;
};

const COLS: { key: CostColumn; label: string }[] = [
  { key: "channel_analysis", label: "Channel" },
  { key: "topic",            label: "Topic" },
  { key: "script",           label: "Script" },
  { key: "visuals",          label: "Visuals" },
  { key: "prompts",          label: "Prompts" },
  { key: "voiceover",        label: "Voiceover" },
  { key: "generate",         label: "Generate" },
  { key: "assemble",         label: "Assemble" },
  { key: "thumbnail",        label: "Thumbnail" },
];

// Supadata is intentionally omitted — transcript fetches are billed to
// the product owner, not the user, so it shouldn't show up in the
// per-project cost breakdown they see. The admin view still includes
// it via its own constant.
const PROVIDER_ORDER = ["anthropic", "kie", "elevenlabs"];
const HIDDEN_PROVIDERS = new Set(["supadata"]);
const PROVIDER_LABEL: Record<string, string> = {
  anthropic:  "Anthropic",
  kie:        "KIE",
  elevenlabs: "ElevenLabs",
};

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) return r.json().catch(() => ({})).then((e: { error?: string }) => { throw new Error(e.error ?? `Request failed (${r.status})`); });
    return r.json();
  });

export default function ProjectCostPage({ params }: PageProps) {
  const { projectId } = params;
  const router = useRouter();
  const { project } = useProject(projectId);

  // "Closes" the cost view by sending the user back to wherever they
  // came from in the workflow. router.back() respects browser history
  // — works even if they deep-linked here (falls back to no-op rather
  // than a fixed page, but in practice the Cost button is only reachable
  // from inside the workflow so history is always non-empty).
  const handleClose = () => router.back();
  const { data, error, isLoading } = useSWR<CostsResponse>(
    projectId ? `/api/projects/${projectId}/costs` : null,
    fetcher,
  );

  const cells = data?.columns;

  // Build the provider × step matrix and per-provider totals exactly
  // the way the admin details view does — same logic, same layout, so
  // the user sees the same breakdown they'd see if an admin opened
  // their project from the dashboard.
  type StepProviderBucket = Record<string, number>;
  const providersSet = new Set<string>();
  const matrix: Record<CostColumn, Record<string, StepProviderBucket>> = {} as Record<CostColumn, Record<string, StepProviderBucket>>;
  for (const c of COLS) {
    matrix[c.key] = {};
    const cell = cells?.[c.key];
    if (!cell) continue;
    for (const b of cell.breakdown) {
      if (HIDDEN_PROVIDERS.has(b.provider)) continue;
      providersSet.add(b.provider);
      const stepProv = matrix[c.key][b.provider] ?? {};
      const kind = b.unitKind.startsWith("claude_tokens_") ? "claude_tokens" : b.unitKind;
      stepProv[kind] = (stepProv[kind] ?? 0) + b.units;
      matrix[c.key][b.provider] = stepProv;
    }
  }
  const extras = Array.from(providersSet)
    .filter((p) => !PROVIDER_ORDER.includes(p) && !HIDDEN_PROVIDERS.has(p))
    .sort((a, b) => a.localeCompare(b));
  const providers = [...PROVIDER_ORDER, ...extras];

  const renderBucket = (bucket: StepProviderBucket | undefined) => {
    if (!bucket) return <span style={{ color: "oklch(0 0 0 / 0.35)" }}>—</span>;
    const parts: string[] = [];
    for (const [kind, units] of Object.entries(bucket)) {
      if (units > 0) parts.push(`${compactNumber(units)} ${unitSuffix(kind)}`);
    }
    return parts.length ? parts.join(" · ") : <span style={{ color: "oklch(0 0 0 / 0.35)" }}>—</span>;
  };

  const providerTotals: Record<string, StepProviderBucket> = {};
  for (const provider of providers) {
    const acc: StepProviderBucket = {};
    for (const c of COLS) {
      const stepBucket = matrix[c.key][provider];
      if (!stepBucket) continue;
      for (const [k, v] of Object.entries(stepBucket)) {
        acc[k] = (acc[k] ?? 0) + v;
      }
    }
    providerTotals[provider] = acc;
  }

  return (
    <div className="flex h-screen" style={{ background: "var(--bg-page-2)" }}>
      <WizardNav
        projectId={projectId}
        currentState={project?.current_state ?? 1}
        highestState={project?.current_state}
        channelName={project?.channel_name}
      />

      <main className="flex-1 overflow-y-auto pt-[105px] md:pt-0">
        <div className="px-4 sm:px-8 py-5"
          style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}>
          <h1 className="font-bold text-lg">Cost breakdown</h1>
          <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
            Per-step usage across each provider. Raw consumption units only —
            no USD conversion.
          </p>
        </div>

        <div className="max-w-5xl mx-auto px-4 sm:px-8 pt-6 sm:pt-8 pb-24 space-y-5">
          {/* Close button sits outside (above) the Title card,
              right-aligned. router.back() drops the user back on the
              workflow step they came from. */}
          <div className="flex justify-end">
            <button
              onClick={handleClose}
              aria-label="Close cost view"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90 cursor-pointer"
              style={{ background: "oklch(0.58 0.22 25)", color: "white", boxShadow: "0 2px 6px oklch(0.58 0.22 25 / 0.3)" }}
            >
              <X size={13} />
              Close
            </button>
          </div>

          {/* Title strip — break-words on the topic keeps long values
              inside the card on narrow phones instead of overflowing
              and forcing horizontal scroll on the whole page. */}
          <div className="rounded-2xl p-4 space-y-1"
            style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}>
            <p className="text-xs uppercase tracking-wider" style={{ color: "black" }}>Title</p>
            <p className="text-base font-semibold break-words" style={{ color: "black" }}>
              {project?.selected_topic ?? project?.channel_name ?? "—"}
            </p>
          </div>

          {error ? (
            <div className="rounded-2xl p-4 text-sm"
              style={{ background: "oklch(0.96 0.04 25)", border: "1px solid oklch(0.6 0.22 25 / 0.3)", color: "oklch(0.45 0.18 25)" }}>
              Couldn&apos;t load cost data: {error.message}
            </div>
          ) : isLoading ? (
            <div className="rounded-2xl p-8 text-center text-sm"
              style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)", color: "var(--c-50)" }}>
              Loading…
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl"
              style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.07)" }}>
              <table className="w-full border-collapse min-w-[640px]" style={{ background: "white", color: "black" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid oklch(0 0 0 / 0.1)", background: "white" }}>
                    <th className="text-left py-2.5 px-3" style={{ background: "white" }} />
                    {providers.map((prov) => (
                      <th key={prov} className="text-left py-2.5 px-3 text-[11px] font-semibold uppercase tracking-wider"
                        style={{ color: "black", background: "white" }}>
                        {PROVIDER_LABEL[prov] ?? prov}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {COLS.map((c) => (
                    <tr key={c.key} style={{ borderBottom: "1px solid oklch(0 0 0 / 0.06)", background: "white" }}>
                      <td className="py-2.5 px-3 text-xs font-bold" style={{ color: "black", background: "white" }}>
                        {c.label}
                      </td>
                      {providers.map((prov) => (
                        <td key={prov} className="py-2.5 px-3 text-xs font-mono tabular-nums" style={{ color: "black", background: "white" }}>
                          {renderBucket(matrix[c.key][prov])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: "2px solid oklch(0 0 0 / 0.15)", background: "white" }}>
                    <td className="py-2.5 px-3 text-[11px] font-bold uppercase tracking-wider"
                      style={{ color: "black", background: "white" }}>
                      Total
                    </td>
                    {providers.map((prov) => (
                      <td key={prov} className="py-2.5 px-3 text-xs font-mono font-bold tabular-nums"
                        style={{ color: "black", background: "white" }}>
                        {renderBucket(providerTotals[prov])}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
