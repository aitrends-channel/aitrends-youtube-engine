"use client";

import useSWR from "swr";
import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { X, ChevronLeft, ChevronRight } from "lucide-react";
import { WizardNav } from "@/components/wizard/WizardNav";
import { useProject } from "@/hooks/useProject";
import { compactNumber, unitSuffix } from "@/lib/cost-display";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { isAdminEmail } from "@/lib/admin";
import { useAdminPlanView } from "@/lib/admin-view";

interface PageProps {
  params: { projectId: string };
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

type CreditLogEntry = {
  column: string | null;
  step: string | null;
  beatNumber: number | null;
  provider: string | null;
  model: string | null;
  type: "charged" | "refunded";
  credits: number;
  at: string;
};

/** What each step is called in the log. Named per step rather than per column:
 *  "Generate" is an image and a clip billed at different prices, and "Prompts"
 *  is two passes, so rolling them up hides the thing being paid for. */
/** Same red the balance chip flashes a refund in, so the two read as one
 *  thing seen twice rather than two unrelated events. */
const REFUND_RED = "oklch(0.68 0.21 25)";

/** Charges green against refunds red, so the two directions read apart at a
 *  glance and the amount does not need its sign to be understood. */
const CHARGE_GREEN = "oklch(0.75 0.16 145)";

/** Rows per page. A forty-beat project writes a few hundred charges, which is
 *  a scroll nobody reads to the end of. */
const PAGE_SIZE = 25;

const STEP_LABEL: Record<string, string> = {
  channel_analysis: "Channel analysis and style",
  topic:            "Video idea generation",
  script:           "Script writing and edits",
  visuals:          "Visual style extraction",
  prompts_image:    "Image prompt generation",
  prompts_video:    "Video prompt generation",
  tts:              "Voiceover narration",
  image_gen:        "Image generation",
  video_gen:        "Video clip generation",
  assemble:         "Final video assembly",
  thumbnail:        "Thumbnail generation",
};

type CostsResponse = {
  projectId: string;
  /** True for an account billed in Heclus credits. Decides which of the two
   *  tables this page is. */
  inCredits?: boolean;
  columns: Record<CostColumn, ColumnSummary>;
  log?: CreditLogEntry[];
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
  poyo:       "PoYo",
};

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) return r.json().catch(() => ({})).then((e: { error?: string }) => { throw new Error(e.error ?? `Request failed (${r.status})`); });
    return r.json();
  });

export default function ProjectCostPage({ params }: PageProps) {
  const { projectId } = params;
  const router = useRouter();
  const searchParams = useSearchParams();
  const { project } = useProject(projectId);
  // Summary mode: hide the wizard sidebar so the cost view stands on
  // its own. Reached via the thumbnails-done flow, where the cost
  // breakdown is the final reveal and the step nav would be visual
  // noise. Read once from the URL — no need for state since changing
  // the param implies a fresh navigation.
  const summaryMode = searchParams.get("summary") === "1";

  // "Closes" the cost view by sending the user back to wherever they
  // came from in the workflow. router.back() respects browser history
  // — works even if they deep-linked here (falls back to no-op rather
  // than a fixed page, but in practice the Cost button is only reachable
  // from inside the workflow so history is always non-empty).
  // In summary mode (arrived from thumbnails Done), the wizard sidebar
  // is hidden so there's no other route out of this view — send X to
  // the dashboard, which is the natural end-of-workflow destination.
  // Otherwise behave like a back button (returns to whatever workflow
  // step they came from).
  const handleClose = () => {
    if (summaryMode) router.push("/dashboard");
    else router.back();
  };
  const { data, error, isLoading } = useSWR<CostsResponse>(
    projectId ? `/api/projects/${projectId}/costs` : null,
    fetcher,
  );

  const cells = data?.columns;
  const log = data?.log ?? [];

  // A charge is negative in the ledger and a refund positive; the list carries
  // the direction in `type` and an unsigned amount, so the net is one subtraction
  // rather than a sum of mixed signs.

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

  const providerInitial = (provider: string): string => {
    switch (provider) {
      case "anthropic":  return "An";
      case "kie":        return "Ki";
      case "elevenlabs": return "El";
      case "supadata":   return "Su";
      default:           return provider.slice(0, 2).replace(/^./, (c) => c.toUpperCase());
    }
  };
  const providerBgFor = (provider: string): string => {
    switch (provider) {
      case "anthropic":  return "oklch(0.72 0.25 285)"; // purple
      case "kie":        return "oklch(0.55 0.15 220)"; // blue
      case "elevenlabs": return "oklch(0.7 0.15 145)";  // green
      case "supadata":   return "oklch(0.55 0.18 65)";  // amber
      default:           return "oklch(0.50 0 0)";      // neutral grey
    }
  };
  const providerBadge = (provider: string) => (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 18,
        height: 18,
        borderRadius: "9999px",
        background: providerBgFor(provider),
        color: "white",
        fontSize: 9,
        fontWeight: 700,
        lineHeight: 1,
        marginRight: 4,
        verticalAlign: "middle",
      }}
    >
      {providerInitial(provider)}
    </span>
  );
  const renderBucket = (bucket: StepProviderBucket | undefined, provider: string) => {
    if (!bucket) return <span style={{ color: "var(--c-38)" }}>—</span>;
    const parts: string[] = [];
    for (const [kind, units] of Object.entries(bucket)) {
      if (units > 0) parts.push(`${compactNumber(units)} ${unitSuffix(kind)}`);
    }
    if (parts.length === 0) return <span style={{ color: "var(--c-38)" }}>—</span>;
    return <>{providerBadge(provider)}{parts.join(" · ")}</>;
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

  // Which table this is. The admin override lives in the wizard header now, so
  // one switch changes every plan-dependent surface at once rather than each
  // page carrying its own.
  const planView = useAdminPlanView();
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    void supabase.auth.getUser().then(({ data }) => {
      const meta = (data.user?.app_metadata ?? {}) as { is_admin?: unknown };
      if (meta.is_admin === true || isAdminEmail(data.user?.email)) setIsAdmin(true);
    });
  }, []);
  const showCredits = isAdmin && planView ? planView === "new" : !!data?.inCredits;

  // Paged in the browser, not the query: the endpoint already returns every
  // row because the totals are summed from the same list, so asking the server
  // again for a slice it has already sent would be a request for nothing.
  const [page, setPage] = useState(0);
  const pageCount = Math.max(1, Math.ceil(log.length / PAGE_SIZE));
  // A project that loses rows under a filter, or simply loads slower than the
  // first render, must not leave the reader on a page that no longer exists.
  useEffect(() => { setPage((p) => Math.min(p, pageCount - 1)); }, [pageCount]);
  const pageRows = log.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const firstOnPage = log.length === 0 ? 0 : page * PAGE_SIZE + 1;
  const lastOnPage = Math.min(log.length, (page + 1) * PAGE_SIZE);

  // Net is over everything, not the page. A total that changed as you paged
  // would be a different number wearing the same label.
  const netCharged = log.reduce(
    (sum, r) => sum + (r.type === "refunded" ? -r.credits : r.credits), 0,
  );

  /** The step's display name. Falls back to the raw step tidied up, then to a
   *  dash: a row whose step this page has no name for is still a real charge,
   *  and dropping it would make the list disagree with the balance. */
  const processLabel = (r: CreditLogEntry): string => {
    // A refund is its own event, not the step that earned it. Naming the step
    // would put two rows called "Image" next to each other, one taking credits
    // and one giving them back.
    if (r.type === "refunded") return "Credit refunded";
    if (!r.step) return "—";
    return STEP_LABEL[r.step]
      ?? r.step.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  };

  /** Local time, to the minute. Seconds add width and answer nothing. */
  const formatWhen = (iso: string): string => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString(undefined, {
      day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
    });
  };

  return (
    <div className="flex h-screen" style={{ background: "var(--bg-page-2)" }}>
      <WizardNav
        projectId={projectId}
        currentState={project?.current_state ?? 1}
        highestState={project?.current_state}
        channelName={project?.channel_name}
        channelUrl={project?.channel_url}
        hideSteps={summaryMode}
      />

      <main className={`flex-1 overflow-y-auto ${summaryMode ? "pt-16 md:pt-20" : "pt-[105px] md:pt-0"}`}>
        <div className="sm:px-8 py-5"
          style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}>
          <h1 className="font-bold text-lg">Cost breakdown</h1>
          <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
            Credits charged and refunded on this project, newest first.
          </p>
        </div>

        <div className="sm:px-8 pt-5 pb-24 space-y-4">
          {/* Title strip — break-words on the topic keeps long values
              inside the card on narrow phones instead of overflowing
              and forcing horizontal scroll on the whole page. */}
          <div className="rounded-2xl p-4 flex items-start justify-between gap-4"
            style={{ background: "var(--bg-card)" }}>
            <div className="min-w-0 space-y-1">
              <p className="text-xs uppercase tracking-wider" style={{ color: "var(--c-45)" }}>Title</p>
              <p className="text-base font-semibold break-words" style={{ color: "var(--c-80)" }}>
                {project?.selected_topic ?? project?.channel_name ?? "—"}
              </p>
            </div>
          {!summaryMode && (
            <button
              onClick={handleClose}
              aria-label="Close cost view"
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90 cursor-pointer"
              style={{ background: "oklch(0.58 0.22 25)", color: "white", boxShadow: "0 2px 6px oklch(0.58 0.22 25 / 0.3)" }}
            >
              <X size={13} />
              Close
            </button>
          )}
          </div>

          {error ? (
            <div className="rounded-2xl p-4 text-sm"
              style={{ background: "oklch(0.96 0.04 25)", border: "1px solid oklch(0.6 0.22 25 / 0.3)", color: "oklch(0.45 0.18 25)" }}>
              Couldn&apos;t load cost data: {error.message}
            </div>
          ) : isLoading ? (
            <div className="rounded-2xl p-8 text-center text-sm"
              style={{ background: "var(--bg-card)", border: "1px solid var(--bd-card)", color: "var(--c-50)" }}>
              Loading…
            </div>
          ) : (
            !showCredits ? (
            /* Old plans keep the provider-unit matrix. They are billed in
               provider units and never take a hold, so there are no ledger
               rows for a credit log to show and the list would be empty. */
            <div className="overflow-x-auto rounded-xl"
              style={{ background: "var(--bg-card)", border: "1px solid var(--bd-card)" }}>
              <table className="w-full border-collapse min-w-[640px]">
                <thead>
                  <tr>
                    <th className="text-left py-2.5 px-3" />
                    {providers.map((prov) => (
                      <th key={prov} className="text-left py-2.5 px-3 text-[11px] font-semibold uppercase tracking-wider"
                        style={{ color: "var(--c-45)" }}>
                        {PROVIDER_LABEL[prov] ?? prov}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {COLS.map((c) => (
                    <tr key={c.key} style={{ borderBottom: "1px solid var(--bd-6)" }}>
                      <td className="py-2.5 px-3 text-xs font-bold" style={{ color: "var(--c-80)" }}>
                        {c.label}
                      </td>
                      {providers.map((prov) => (
                        <td key={prov} className="py-2.5 px-3 text-xs font-mono tabular-nums" style={{ color: "var(--c-70)" }}>
                          {renderBucket(matrix[c.key][prov], prov)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: "1px solid var(--bd-card)" }}>
                    <td className="py-2.5 px-3 text-[11px] font-bold uppercase tracking-wider"
                      style={{ color: "var(--c-45)" }}>
                      Total
                    </td>
                    {providers.map((prov) => (
                      <td key={prov} className="py-2.5 px-3 text-xs font-mono font-bold tabular-nums"
                        style={{ color: "var(--c-80)" }}>
                        {renderBucket(providerTotals[prov], prov)}
                      </td>
                    ))}
                  </tr>
                </tfoot>
              </table>
            </div>
            ) : (
            <div
              /* Breathing room round the table once there is width for it.
                 Kept off small screens, where 20px a side is width the
                 columns need more than the margin does. */
              className="overflow-x-auto rounded-xl lg:py-5 lg:px-8 xl:px-10"
              style={{ background: "var(--bg-card)", border: "1px solid var(--bd-card)" }}>
              {log.length === 0 ? (
                <p className="py-8 text-center text-sm" style={{ color: "var(--c-45)" }}>
                  Nothing charged on this project yet.
                </p>
              ) : (
              <table className={`w-full border-collapse table-fixed ${isAdmin ? "min-w-[720px]" : "min-w-[560px]"}`}>
                {/* Fixed columns, so a long process name cannot squeeze the
                    amount, and the three narrow columns line up down the page
                    instead of shifting row to row. */}
                <colgroup>
                  <col />
                  {isAdmin && <col style={{ width: "190px" }} />}
                  <col style={{ width: "110px" }} />
                  <col style={{ width: "110px" }} />
                  <col style={{ width: "160px" }} />
                </colgroup>
                <thead>
                  <tr>
                    {(isAdmin
                      ? ["Process", "Model", "Type", "Credits", "Date/Time"]
                      : ["Process", "Type", "Credits", "Date/Time"]
                    ).map((h) => (
                      <th key={h}
                        className={`py-2.5 px-3 text-[11px] font-semibold uppercase tracking-wider ${h === "Credits" || h === "Date/Time" ? "text-right" : "text-left"}`}
                        style={{ color: "var(--c-45)" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((r, i) => (
                    <tr key={`${r.at}-${i}`} style={{ borderBottom: "1px solid var(--bd-6)" }}>
                      <td className="py-2.5 px-3 text-xs font-bold truncate" style={{ color: "var(--c-80)" }}>
                        {processLabel(r)}
                        {/* Which beat, where there is one. A hundred image
                            rows that all say "Image" name nothing. */}
                        {r.beatNumber !== null && (
                          <span className="font-normal" style={{ color: "var(--c-45)" }}>
                            {` · beat ${r.beatNumber}`}
                          </span>
                        )}
                      </td>
                      {isAdmin && (
                        /* A refund is not a generation, so it names no model. */
                        <td className="py-2.5 px-3 text-xs font-mono truncate" style={{ color: "var(--c-55)" }}>
                          {r.type === "refunded" ? "—" : r.model ?? "—"}
                        </td>
                      )}
                      <td className="py-2.5 px-3 text-xs">
                        {/* Colour carries the direction, so the two read apart
                            at a glance without the amount needing a sign. */}
                        <span className="px-1.5 py-0.5 rounded text-[11px] font-medium"
                          style={r.type === "refunded"
                            ? { background: "oklch(0.7 0.19 25 / 0.15)", color: REFUND_RED }
                            : { background: "oklch(0.7 0.16 145 / 0.13)", color: CHARGE_GREEN }}>
                          {r.type === "refunded" ? "Refund" : "Charged"}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-xs font-mono tabular-nums text-right"
                        style={{ color: r.type === "refunded" ? REFUND_RED : CHARGE_GREEN }}>
                        {r.type === "refunded" ? "+" : "−"}
                        {r.credits.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                      </td>
                      <td className="py-2.5 px-3 text-xs tabular-nums text-right whitespace-nowrap"
                        style={{ color: "var(--c-45)" }}>
                        {formatWhen(r.at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: "1px solid var(--bd-card)" }}>
                    <td className="py-2.5 px-3 text-[11px] font-bold uppercase tracking-wider"
                      style={{ color: "var(--c-45)" }} colSpan={isAdmin ? 3 : 2}>
                      Net charged
                    </td>
                    <td className="py-2.5 px-3 text-xs font-mono font-bold tabular-nums text-right"
                      style={{ color: "var(--c-80)" }}>
                      {netCharged.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
              )}
              {/* Only once there is a second page. Controls for one page of
                  results are furniture explaining nothing. */}
              {pageCount > 1 && (
                <div className="flex items-center justify-between gap-3 px-3 py-2.5"
                  style={{ borderTop: "1px solid var(--bd-6)" }}>
                  <span className="text-[11px] tabular-nums" style={{ color: "var(--c-45)" }}>
                    {firstOnPage}-{lastOnPage} of {log.length}
                  </span>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                      disabled={page === 0}
                      aria-label="Previous page"
                      className="p-1.5 rounded-lg transition-opacity disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-80"
                      style={{ background: "var(--bg-track)", color: "var(--c-65)" }}
                    >
                      <ChevronLeft size={14} />
                    </button>
                    <span className="text-[11px] tabular-nums px-1" style={{ color: "var(--c-55)" }}>
                      {page + 1} / {pageCount}
                    </span>
                    <button
                      type="button"
                      onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                      disabled={page >= pageCount - 1}
                      aria-label="Next page"
                      className="p-1.5 rounded-lg transition-opacity disabled:opacity-30 disabled:cursor-not-allowed hover:opacity-80"
                      style={{ background: "var(--bg-track)", color: "var(--c-65)" }}
                    >
                      <ChevronRight size={14} />
                    </button>
                  </div>
                </div>
              )}
            </div>
            )
          )}

          {/* End-of-flow CTAs — only in summary mode (arrived via the
              thumbnails-Done button). Two paths out: review at the
              dashboard, or kick off a brand-new project from the
              /next page. Stacked on mobile, side-by-side on sm+. */}
          {summaryMode && (
            <div className="flex flex-col sm:flex-row gap-3 pt-4">
              <button
                onClick={() => router.push("/dashboard")}
                className="flex-1 py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
              >
                Go to Dashboard
              </button>
              <button
                onClick={() => router.push(`/projects/${projectId}/next`)}
                className="flex-1 py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
              >
                Start new video
              </button>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
