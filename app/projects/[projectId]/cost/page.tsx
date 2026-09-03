"use client";

import useSWR from "swr";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { X, ChevronLeft, ChevronRight, Play, Square } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
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
  beatsFrom?: number | null;
  beatsTo?: number | null;
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

/** What the charge produced, as a thing rather than as a process. "Video prompt
 *  generation" is what happened; "Video prompt" is what came out of it, and it
 *  is what somebody scanning this column is looking for. */
const STEP_KIND: Record<string, string> = {
  channel_analysis: "Channel",
  topic:            "Topic",
  script:           "Script",
  visuals:          "Visuals",
  prompts_image:    "Image prompt",
  prompts_video:    "Video prompt",
  tts:              "Voiceover",
  image_gen:        "Image",
  video_gen:        "Video",
  assemble:         "Video",
  thumbnail:        "Thumbnail",
  thumbnail_concept: "Thumbnail",
  thumbnail_image:  "Thumbnail",
};

/** One beat, as much of it as this page needs. The project payload is wider
 *  and untyped; naming the four fields keeps the preview honest about what it
 *  can show. */
interface PreviewBeat {
  beatNumber: number;
  imageUrl?: string | null;
  videoUrl?: string | null;
  voiceoverUrl?: string | null;
  imagePrompt?: string | null;
  videoPrompt?: string | null;
  scriptSegment?: string | null;
}

/** The project-wide results, for the steps that produce one thing rather than
 *  one thing per beat. */
interface ProjectPreviewFields {
  assembled_url?: string | null;
  script?: string | null;
  selected_topic?: string | null;
  visual_profile?: unknown;
  channel_analysis?: unknown;
}

/** What a row's result opens as. The cell renders from this and the modal
 *  renders from this, so a row can only ever show what it can open. */
type Preview =
  | { kind: "image"; title: string; src: string }
  | { kind: "video"; title: string; src: string; poster?: string | null }
  | { kind: "text";  title: string; text: string };

/**
 * What the charge bought, where there is something to show.
 *
 * A row naming beat 12 and a number is a receipt; the thing it paid for is
 * what says whether it was worth it. Pictures and clips are the thumbnail
 * itself, text is a View button, because a prompt squeezed into a 90px column
 * is neither readable nor a preview of anything.
 */
function previewFor(
  step: string | null,
  beat: PreviewBeat | null,
  project: ProjectPreviewFields,
  beats: PreviewBeat[],
  span: { from: number; to: number } | null,
): Preview | null {
  const of = (n: number | undefined) => (typeof n === "number" ? ` · beat ${n}` : "");
  if (!step) return null;

  if (beat) {
    if (step === "image_gen" && beat.imageUrl) {
      return { kind: "image", title: `Image${of(beat.beatNumber)}`, src: beat.imageUrl };
    }
    if (step === "video_gen" && beat.videoUrl) {
      return { kind: "video", title: `Clip${of(beat.beatNumber)}`, src: beat.videoUrl, poster: beat.imageUrl };
    }
    if (step === "prompts_image" && beat.imagePrompt) {
      return { kind: "text", title: `Image prompt${of(beat.beatNumber)}`, text: beat.imagePrompt };
    }
    if (step === "prompts_video" && beat.videoPrompt) {
      return { kind: "text", title: `Video prompt${of(beat.beatNumber)}`, text: beat.videoPrompt };
    }
    if (step === "script" && beat.scriptSegment) {
      return { kind: "text", title: `Script${of(beat.beatNumber)}`, text: beat.scriptSegment };
    }
  }

  // Prompt writing is billed per call, not per beat: one charge covers a chunk
  // of the script and the row carries no beat number, which left every one of
  // them showing a dash. What that call produced IS the prompts, so the row
  // opens them, every beat that has one, in order.
  if (step === "prompts_image" || step === "prompts_video") {
    const field = step === "prompts_image" ? "imagePrompt" : "videoPrompt";
    // The beats this charge covered, where the charge recorded them. Older
    // rows recorded nothing, so they still open the whole set rather than
    // claiming a range they never knew.
    const inSpan = (b: PreviewBeat) =>
      span === null || (b.beatNumber >= span.from && b.beatNumber <= span.to);
    const written = beats.filter((b) => (b[field] ?? "").trim() && inSpan(b));
    if (written.length) {
      const what = step === "prompts_image" ? "Image" : "Video";
      return {
        kind: "text",
        title: span
          ? `${what} prompts · beats ${span.from}-${span.to}`
          : `${what} prompts · all ${written.length} beat${written.length === 1 ? "" : "s"}`,
        text: written.map((b) => `Beat ${b.beatNumber}\n${b[field]}`).join("\n\n"),
      };
    }
  }

  // Steps that produce one thing for the whole project rather than per beat.
  if (step === "assemble" && project.assembled_url) {
    return { kind: "video", title: "Final video", src: project.assembled_url };
  }
  if (step === "script" && project.script) {
    return { kind: "text", title: "Script", text: project.script };
  }
  if (step === "topic" && project.selected_topic) {
    return { kind: "text", title: "Video idea", text: project.selected_topic };
  }
  if (step === "visuals" && project.visual_profile) {
    return { kind: "text", title: "Visual style", text: asText(project.visual_profile) };
  }
  if (step === "channel_analysis" && project.channel_analysis) {
    return { kind: "text", title: "Channel analysis", text: asText(project.channel_analysis) };
  }
  return null;
}

/** Structured columns are objects. Rendered as their own JSON rather than as
 *  "[object Object]", which is what a stringify-free version showed. */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

/** Plays one voiceover without a player sitting in every row. */
function AudioPreview({ url }: { url: string }) {
  const ref = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  return (
    <button
      type="button"
      title="Play the narration for this beat"
      onClick={() => {
        const el = ref.current ?? new Audio(url);
        ref.current = el;
        el.onended = () => setPlaying(false);
        if (playing) { el.pause(); el.currentTime = 0; setPlaying(false); }
        else { void el.play().then(() => setPlaying(true)).catch(() => setPlaying(false)); }
      }}
      className="inline-flex h-7 w-11 items-center justify-center rounded-md transition-opacity hover:opacity-80"
      style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-8)", color: "var(--accent-blue-text)" }}
    >
      {playing ? <Square size={11} /> : <Play size={11} />}
    </button>
  );
}

function ResultCell({ preview, voiceoverUrl, onOpen }: {
  preview: Preview | null;
  /** The one result that plays where it sits: a play button IS the preview. */
  voiceoverUrl?: string | null;
  onOpen: (p: Preview) => void;
}) {
  if (voiceoverUrl) return <AudioPreview url={voiceoverUrl} />;
  if (!preview) return <span style={{ color: "var(--c-30)" }}>—</span>;

  if (preview.kind === "text") {
    return (
      <button
        type="button"
        onClick={() => onOpen(preview)}
        title={preview.text.slice(0, 200)}
        className="inline-flex h-7 items-center rounded-md px-2.5 text-[11px] font-semibold transition-opacity hover:opacity-80"
        style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-8)", color: "var(--accent-blue-text)" }}
      >
        View
      </button>
    );
  }

  // A clip shows the frame it was made from with a play badge: a video element
  // per row is a download per row for something nobody has asked to watch.
  const thumb = preview.kind === "image" ? preview.src : preview.poster;
  return (
    <button
      type="button"
      onClick={() => onOpen(preview)}
      title={preview.kind === "image" ? "View the image" : "Play the clip"}
      className="relative inline-block h-7 w-11 overflow-hidden rounded-md transition-opacity hover:opacity-80"
      style={{ border: "1px solid var(--bd-8)", background: "var(--bg-progress)" }}
    >
      {thumb && (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={thumb} alt="" className="h-full w-full object-cover" loading="lazy" decoding="async" />
      )}
      {preview.kind === "video" && (
        <span className="absolute inset-0 flex items-center justify-center"
          style={{ background: "oklch(0 0 0 / 0.35)", color: "white" }}>
          <Play size={11} />
        </span>
      )}
    </button>
  );
}

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

  // What the Result column has opened, if anything.
  const [preview, setPreview] = useState<Preview | null>(null);

  // The beat each charge belongs to, for the Result column. Already in memory:
  // the page loads the project for the wizard nav, and the beats ride with it.
  const beatList = useMemo(
    () => ((project as { beats?: PreviewBeat[] } | undefined)?.beats ?? []),
    [project],
  );
  const beatsByNumber = useMemo(() => {
    const map = new Map<number, PreviewBeat>();
    for (const b of beatList) if (typeof b.beatNumber === "number") map.set(b.beatNumber, b);
    return map;
  }, [beatList]);

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

      <main className={`flex-1 overflow-y-auto ${summaryMode ? "pt-16 md:pt-20" : "pt-[92px] md:pt-0"}`}>
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
              /* Quiet. Closing a read-only view is not a destructive act, and
                 a filled red button beside a table of charges reads as one. */
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80 cursor-pointer"
              style={{ background: "transparent", border: "1px solid var(--bd-8)", color: "var(--c-60)" }}
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
              <table className={`w-full border-collapse table-fixed ${isAdmin ? "min-w-[980px]" : "min-w-[800px]"}`}>
                {/* Fixed columns, so a long process name cannot squeeze the
                    amount, and the three narrow columns line up down the page
                    instead of shifting row to row. */}
                <colgroup>
                  <col />
                  <col style={{ width: "120px" }} />
                  {isAdmin && <col style={{ width: "170px" }} />}
                  <col style={{ width: "110px" }} />
                  <col style={{ width: "100px" }} />
                  <col style={{ width: "110px" }} />
                  <col style={{ width: "160px" }} />
                </colgroup>
                <thead>
                  <tr>
                    {/* Type is what came out, Action is what the credits did.
                        The badge column used to be called Type, which left the
                        table with no word for the thing being paid for. */}
                    {(isAdmin
                      ? ["Process", "Type", "Model", "Result", "Action", "Credits", "Date/Time"]
                      : ["Process", "Type", "Result", "Action", "Credits", "Date/Time"]
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
                      <td className="py-2.5 px-3 text-xs truncate" style={{ color: "var(--c-55)" }}>
                        {(r.step && STEP_KIND[r.step]) ?? "—"}
                      </td>
                      {isAdmin && (
                        /* A refund is not a generation, so it names no model. */
                        <td className="py-2.5 px-3 text-xs font-mono truncate" style={{ color: "var(--c-55)" }}>
                          {r.type === "refunded" ? "—" : r.model ?? "—"}
                        </td>
                      )}
                      <td className="py-2.5 px-3 text-xs">
                        {/* Only a charge has something to show: a refund is the
                            credits coming back, not a second artefact. */}
                        {(() => {
                          if (r.type === "refunded") return <span style={{ color: "var(--c-30)" }}>—</span>;
                          const beat = r.beatNumber === null ? null : beatsByNumber.get(r.beatNumber) ?? null;
                          return (
                            <ResultCell
                              preview={previewFor(
                                r.step,
                                beat,
                                (project ?? {}) as ProjectPreviewFields,
                                beatList,
                                typeof r.beatsFrom === "number" && typeof r.beatsTo === "number"
                                  ? { from: r.beatsFrom, to: r.beatsTo }
                                  : null,
                              )}
                              voiceoverUrl={r.step === "tts" ? beat?.voiceoverUrl : null}
                              onOpen={setPreview}
                            />
                          );
                        })()}
                      </td>
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
                      style={{ color: "var(--c-45)" }} colSpan={isAdmin ? 5 : 4}>
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

      {/* What the Result column opens. One dialog for every row rather than a
          new tab per click: the log is a list you read down, and losing the
          page to open one image is how you lose your place in it. */}
      <Dialog open={!!preview} onOpenChange={(next) => { if (!next) setPreview(null); }}>
        <DialogContent className="sm:max-w-3xl p-0 gap-0 max-h-[90dvh] overflow-hidden">
          <DialogHeader className="px-5 py-3.5 pr-12 border-b" style={{ borderColor: "var(--bd-6)" }}>
            <DialogTitle className="text-sm font-semibold">{preview?.title ?? "Result"}</DialogTitle>
            <DialogDescription className="sr-only">What this charge produced.</DialogDescription>
          </DialogHeader>
          <div className="max-h-[calc(90dvh-56px)] overflow-y-auto">
            {preview?.kind === "image" && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img src={preview.src} alt={preview.title} className="w-full max-h-[75vh] object-contain" style={{ background: "oklch(0 0 0 / 0.35)" }} />
            )}
            {preview?.kind === "video" && (
              <video src={preview.src} poster={preview.poster ?? undefined} controls autoPlay
                className="w-full max-h-[75vh]" style={{ background: "oklch(0 0 0 / 0.35)" }} />
            )}
            {preview?.kind === "text" && (
              <p className="whitespace-pre-wrap px-5 py-4 text-[13px] leading-relaxed">{preview.text}</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
