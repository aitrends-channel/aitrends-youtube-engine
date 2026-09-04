"use client";

import { useState, useEffect, Fragment } from "react";
import useSWR from "swr";
import { useRouter, usePathname } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import {
  Tv, Lightbulb, ScrollText, ImageIcon, Wand2, Mic, Clapperboard, Film,
  Check, CheckCircle2, LayoutTemplate, X, Settings, LogOut, DollarSign, KeyRound, Wallet, Menu,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useIconThemeStore } from "@/store/iconThemeStore";
import { type PhaseKey } from "@/lib/iconThemes";
import { isHeclusCreditsPlan, planLabel } from "@/lib/plan-tier";
import { compactNumber, unitSuffix } from "@/lib/cost-display";
import { setAdminPlanView, useAdminPlanView, useOnCreditsPlan } from "@/lib/admin-view";
import { isAdminEmail } from "@/lib/admin";
import { ThemeToggle } from "@/components/ThemeToggle";
import { CopyButton } from "@/components/CopyButton";
import { KieBalanceRow } from "@/components/KieBalanceRow";
import { ElevenLabsBalanceRow } from "@/components/ElevenLabsBalanceRow";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

const PHASES: { id: PhaseKey; label: string; sublabel: string; path: string; states: number[]; navigableFrom?: number }[] = [
  { id: "channel",    label: "Channel",    sublabel: "Analysis & Style",    path: "channel",    states: [1, 2, 3, 4, 5] },
  { id: "topic",      label: "Topic",      sublabel: "Video Idea",           path: "topic",      states: [6] },
  { id: "script",     label: "Script",     sublabel: "Generate & Edit",     path: "script",     states: [6], navigableFrom: 7 },
  { id: "visuals",    label: "Visuals",    sublabel: "Style Extraction",    path: "visuals",    states: [7, 8, 11, 12], navigableFrom: 7 },
  { id: "prompts",    label: "Prompts",    sublabel: "Image & Video Beats", path: "prompts",    states: [9, 10] },
  { id: "voiceover",  label: "Voiceover",  sublabel: "Per-beat Narration",  path: "voiceover",  states: [9], navigableFrom: 9 },
  { id: "generate",   label: "Generate",   sublabel: "Assets & Export",     path: "generate",   states: [14] },
  { id: "assemble",   label: "Assemble",   sublabel: "Final Video",         path: "assemble",   states: [15], navigableFrom: 14 },
  { id: "thumbnails", label: "Thumbnails", sublabel: "Concepts & Images",   path: "thumbnails", states: [13], navigableFrom: 9 },
];

// What each step has cost, keyed the way /api/projects/[id]/costs reports it.
// Named separately from the phase ids because the two vocabularies differ:
// the nav says "channel" and "thumbnails", the cost rollup says
// "channel_analysis" and "thumbnail".
const PHASE_COST_COLUMN: Record<PhaseKey, string> = {
  channel:    "channel_analysis",
  topic:      "topic",
  script:     "script",
  visuals:    "visuals",
  prompts:    "prompts",
  voiceover:  "voiceover",
  generate:   "generate",
  assemble:   "assemble",
  thumbnails: "thumbnail",
};

interface StepCosts {
  columns: Record<string, {
    heclusCreditsCharged?: number;
    /** Raw provider units for the step, keyed by unit kind. What an account on
     *  an old plan actually spends, since it holds no Heclus credits. */
    totals?: Record<string, number>;
  }>;
  inCredits?: boolean;
}

// The unit to show beside a step for an account funded by its own keys.
//
// One per row, not a breakdown: the row already carries a label and a
// sublabel, and most steps spend on a single provider anyway. Whatever else
// the step spent is on the hover.
//
// Ordered by what the money is: KIE credits and ElevenLabs characters are
// billed to the customer directly, Claude tokens reach them through the KIE
// relay, and Supadata is ours and is hidden from everyone but an admin.
const UNIT_PRIORITY = ["kie_credits", "elevenlabs_chars", "claude_tokens", "supadata_transcripts"];

/** Provider units for one step, with the four Claude token kinds collapsed the
 *  way every other cost surface collapses them. */
function unitsForColumn(
  totals: Record<string, number> | undefined,
  isAdmin: boolean,
): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const [kind, units] of Object.entries(totals ?? {})) {
    if (typeof units !== "number" || !(units > 0)) continue;
    if (kind === "supadata_transcripts" && !isAdmin) continue;
    const key = kind.startsWith("claude_tokens") ? "claude_tokens" : kind;
    merged[key] = (merged[key] ?? 0) + units;
  }
  return merged;
}

const costsFetcher = (url: string) => fetch(url).then((r) => r.json() as Promise<StepCosts>);

const PHASE_ICONS: Record<PhaseKey, LucideIcon> = {
  channel:    Tv,
  topic:      Lightbulb,
  script:     ScrollText,
  visuals:    ImageIcon,
  prompts:    Wand2,
  voiceover:  Mic,
  thumbnails: LayoutTemplate,
  generate:   Clapperboard,
  assemble:   Film,
};

const PATH_RANK: Record<string, number> = {
  channel: 0, topic: 1, script: 2, visuals: 3, prompts: 4, voiceover: 5, generate: 6, assemble: 7, thumbnails: 8,
};

interface WizardNavProps {
  projectId: string;
  currentState: number;
  highestState?: number;
  channelName?: string;
  /** The niche's channel address, offered for copying beside its name. */
  channelUrl?: string;
  activeOverridePath?: string;
  /** The main video is done — its final MP4 assembled. Drives the 100%
   *  progress bar and the Assemble step's green tick. Independent of
   *  thumbnails (an extra step that doesn't affect progress). */
  progressComplete?: boolean;
  /** All thumbnail images generated. The ONLY thing that greens the
   *  Thumbnails step — an assembled video alone doesn't. */
  thumbnailsComplete?: boolean;
  topRightExtra?: React.ReactNode;
  /** Hide the step navigation (desktop sidebar, mobile step-dots
   *  row, mobile drawer) but keep the logo + Back/Cost/Theme/Profile
   *  cluster. Used by the cost-summary view at the end of the
   *  thumbnails-Done flow, where the workflow nav is irrelevant but
   *  global controls should still be reachable. */
  hideSteps?: boolean;
}

export function WizardNav({ projectId, currentState, highestState, channelName, channelUrl, activeOverridePath, progressComplete, thumbnailsComplete, topRightExtra, hideSteps }: WizardNavProps) {
  const reached = highestState ?? currentState;
  const router = useRouter();
  const pathname = usePathname();
  const { zoom } = useIconThemeStore();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerHighlightPhase, setDrawerHighlightPhase] = useState(-1);
  const [userEmail, setUserEmail] = useState("");
  // Plan + paid status drive the plan pill in the profile menu so
  // it matches DashboardHeader's behavior across every workflow view.
  // Defaults to free/starter until the auth fetch lands.
  const [userPlan, setUserPlan] = useState<string>("starter");
  const [isPaid, setIsPaid] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);
  const [showProfileMenu, setShowProfileMenu] = useState(false);

  // What this video has charged, per step, beside each step. The number was
  // only ever on the page you were standing on, so answering "where did the
  // credits go" meant walking all nine steps and remembering each one.
  // Skipped for wizard placeholder ids like "new-fork", which are not projects
  // and would send the costs route a non-uuid.
  const isRealProject = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId);
  const { data: stepCosts } = useSWR<StepCosts>(
    isRealProject ? `/api/projects/${projectId}/costs` : null,
    costsFetcher,
    { refreshInterval: 15_000, revalidateOnFocus: false },
  );
  // Only the accounts the number means something to.
  //
  // A customer on one of the old products pays no Heclus credits at all, so a
  // credit figure beside each step is a number from a currency they do not
  // hold. Admins see it regardless, including while acting as someone else,
  // because checking what a video cost is most of the reason to be in there.
  // inCredits is still required for customers: a Heclus plan whose work is
  // funded from their own keys has no credit charges to show.
  // What this browser is pretending to be, for an admin. Everyone else reads
  // their real plan.
  const planView = useAdminPlanView();
  const [switchingView, setSwitchingView] = useState(false);
  const onCredits = useOnCreditsPlan(userPlan, isAdmin);
  // Follows the switch rather than short-circuiting on isAdmin. These were the
  // one surface that ignored it, so flipping to Old changed the Cost button,
  // the Logs button and the cost page while these numbers stayed, which makes
  // the switch a partial answer to "what does that user see".
  const showStepCredits = onCredits && (isAdmin || !!stepCosts?.inCredits);

  // The same figures for the other half of the customer base.
  //
  // An old-plan account was the only one with nothing here: the credit number
  // is meaningless to it, so the slot was simply empty, and "what has this
  // video cost me so far" meant opening the Cost view. It spends real units on
  // its own keys, so those go in the same place.
  const showStepUnits = !onCredits;

  const creditsForPhase = (id: PhaseKey): number =>
    Number(stepCosts?.columns?.[PHASE_COST_COLUMN[id]]?.heclusCreditsCharged ?? 0);

  const unitsForPhase = (id: PhaseKey): Record<string, number> =>
    unitsForColumn(stepCosts?.columns?.[PHASE_COST_COLUMN[id]]?.totals, isAdmin);

  // Hand abandoned holds back while somebody is actually here.
  //
  // The hourly cron is the backstop and on its own it is not fast enough to be
  // believed: a hold taken at 18 past goes stale at 1:18 and is not looked at
  // until 2:17. A customer working through a project is watching that balance,
  // and it is the number that decides whether they can start the next step.
  //
  // Same windows as the cron, so this releases nothing the cron would not have
  // released later, and never a hold belonging to a run still in flight. Fired
  // on mount and every five minutes after, only on the workflow pages, which is
  // where this nav lives.
  useEffect(() => {
    if (!isRealProject) return;
    const sweep = () => { void fetch("/api/credits/sweep", { method: "POST" }).catch(() => undefined); };
    sweep();
    const timer = setInterval(sweep, 5 * 60_000);
    return () => clearInterval(timer);
  }, [isRealProject]);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getUser().then(({ data }) => {
      if (data.user?.email) setUserEmail(data.user.email);
      const meta = (data.user?.app_metadata ?? {}) as { plan?: unknown; paid?: unknown; is_admin?: unknown };
      if (typeof meta.plan === "string" && meta.plan.trim()) setUserPlan(meta.plan.trim());
      if (meta.paid === true) setIsPaid(true);
      // Both halves, the way lib/admin.ts defines admin. Reading only the
      // metadata flag left the founder account, which is an admin by email and
      // may carry no flag at all, seeing none of the admin surfaces here.
      if (meta.is_admin === true || isAdminEmail(data.user?.email)) setIsAdmin(true);
    });
  }, []);

  // Hide the plan pill on the /plan page itself — the user is
  // already looking at plan options there, surfacing it again in
  // the menu is just noise.
  const showPlanPill = !pathname?.startsWith("/plan");

  // Apply zoom only on desktop — never touch document.documentElement.style.zoom on touch
  // devices as it disrupts iOS Safari's viewport scale calculation.
  useEffect(() => {
    const isTouch = navigator.maxTouchPoints > 0 || "ontouchstart" in window;
    if (isTouch) return;
    document.documentElement.style.zoom = `${zoom / 100}`;
    return () => { document.documentElement.style.zoom = ""; };
  }, [zoom]);

  async function handleSignOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  const effectivePath = activeOverridePath ? `/${activeOverridePath}` : pathname;
  const currentPathRank = Object.entries(PATH_RANK).find(([p]) => effectivePath.endsWith(`/${p}`))?.[1] ?? -1;

  // Completion, independent of which page is open — so a step can be BOTH
  // the current page (active border) AND done (green tick). Assemble is
  // done once the final MP4 exists; thumbnails ONLY once every thumbnail
  // image is generated; every other step once state has moved past it.
  function phaseDone(phase: (typeof PHASES)[0]) {
    if (phase.id === "thumbnails") return !!thumbnailsComplete;
    if (phase.id === "assemble") return !!progressComplete || reached > Math.max(...phase.states);
    return reached > Math.max(...phase.states);
  }

  function getPhaseStatus(phase: (typeof PHASES)[0]) {
    // The current page always reads "active" (drives the highlight); the
    // green tick is layered on separately via phaseDone in the render.
    if (effectivePath.endsWith(`/${phase.path}`)) return "active";
    if (phaseDone(phase)) return "done";
    return "locked";
  }

  function isNavigable(phase: (typeof PHASES)[0]) {
    const phaseRank = PATH_RANK[phase.id] ?? 0;
    // Green-ticked (done) phases stay clickable regardless of
    // position — if the user has demonstrably completed a phase,
    // clicking its tick is a legitimate "revisit" action even when
    // that phase sits ahead of the page they happen to be on.
    if (getPhaseStatus(phase) === "done") return true;
    // Otherwise, forward navigation is disabled — users advance via
    // the wizard's Next / Continue buttons, not by jumping ahead.
    // The previous navigableFrom-based shortcut let a user skip
    // back to Channel and then click straight to Assemble, which
    // surfaced half-initialized state on intermediate pages.
    if (phaseRank > currentPathRank) return false;
    return reached >= Math.min(...phase.states);
  }

  // Prefetch every navigable phase URL so clicking a green-ticked
  // step doesn't pay the page-bundle + RSC fetch on the critical
  // click→render path. Re-runs when reached / current path changes
  // because that's when the set of navigable phases shifts. Next.js
  // dedupes redundant prefetches, so calling per render is safe.
  useEffect(() => {
    if (projectId === "new-fork") return;
    for (const phase of PHASES) {
      const phaseRank = PATH_RANK[phase.id] ?? 0;
      const done = reached > Math.max(...phase.states);
      const navigable = done || (phaseRank <= currentPathRank && reached >= Math.min(...phase.states));
      if (navigable) router.prefetch(`/projects/${projectId}/${phase.path}`);
    }
  }, [reached, currentPathRank, projectId, router]);

  const currentPhaseIndex = PHASES.findIndex((p) => pathname.endsWith(`/${p.path}`));
  // Cap at 99% until progressComplete signals everything is truly done.
  // Thumbnails is the final phase (index 7 of 8) so the raw fraction would
  // be 100% the moment the user lands on the page — even before any
  // thumbnails have generated. Hold at 99 until the parent confirms.
  const progressPct = progressComplete
    ? 100
    : Math.min(99, Math.max(0, Math.round(((currentPhaseIndex + 1) / PHASES.length) * 100)));

  // router.push fires urgently (no startTransition wrap) so
  // prefetched routes swap immediately. pendingHref drives just the
  // small sidebar step-icon spinner — cheap, localized, and instant
  // acknowledgment of the click. No full-view overlay: it was
  // forcing GPU compositing (backdrop-filter) and making the page
  // feel more sluggish than the navigation actually was.
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  function navigate(href: string) {
    setDrawerOpen(false);
    setPendingHref(href);
    router.push(href);
  }

  // Clear the sidebar spinner once the URL settles on the target.
  useEffect(() => {
    if (pendingHref && pathname.endsWith(pendingHref.split("/").pop() ?? "")) {
      setPendingHref(null);
    }
  }, [pathname, pendingHref]);

  function closeDrawer() {
    setDrawerOpen(false);
    setDrawerHighlightPhase(-1);
  }

  // Progress bar. Rendered INSIDE the step list, directly above the
  // Thumbnails step — the main video's progress ends at Assemble, and
  // thumbnails are an extra step that sits below the bar.
  const progressBar = (
    <div className="px-1 py-3 my-1 border-t border-b" style={{ borderColor: "var(--bd-6)" }}>
      <div className="flex justify-between text-xs mb-2" style={{ color: progressPct === 100 ? "oklch(0.7 0.15 145)" : "var(--c-45)" }}>
        <span>Progress</span>
        <span>{progressPct}%</span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--bg-progress)" }}>
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${progressPct}%`,
            background: progressPct === 100
              ? "linear-gradient(90deg, oklch(0.55 0.15 145), oklch(0.65 0.18 155))"
              : "linear-gradient(90deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))",
            boxShadow: "0 0 8px oklch(0.72 0.25 285 / 0.5)",
          }}
        />
      </div>
    </div>
  );

  const stepList = (
    <nav className="flex-1 px-3 py-5 space-y-1 overflow-y-auto">
      {PHASES.map((phase, i) => {
        const status = getPhaseStatus(phase);
        const navigable = isNavigable(phase);
        const isActive = status === "active";
        const isDone = phaseDone(phase);
        // Current page that's also complete (e.g. Assemble after the video
        // assembled) → keep the active highlight but in green, plus the tick.
        const isActiveDone = isActive && isDone;
        const isHighlighted = i === drawerHighlightPhase && drawerHighlightPhase >= 0;
        const href = `/projects/${projectId}/${phase.path}`;
        const isPending = pendingHref === href;
        const Icon = PHASE_ICONS[phase.id];
        const stepCredits = creditsForPhase(phase.id);
        const stepUnits = showStepUnits ? unitsForPhase(phase.id) : {};
        const primaryUnit = UNIT_PRIORITY.find((k) => (stepUnits[k] ?? 0) > 0)
          ?? Object.keys(stepUnits)[0];

        return (
          <div key={phase.id}>
            {phase.id === "thumbnails" && progressBar}
            <button
              onClick={() => navigable && navigate(href)}
              // Belt-and-suspenders prefetch: the mount-time useEffect
              // already prefetches every navigable route, but on slow
              // networks that can lose the race with a click. Hover
              // (desktop) and pointer-down (touch) give the router a
              // final chance to warm the route before navigation.
              onMouseEnter={() => { if (navigable) router.prefetch(href); }}
              onPointerDown={() => { if (navigable) router.prefetch(href); }}
              disabled={!navigable || isPending}
              className={cn(
                "w-full flex items-center gap-3 px-3 py-3 rounded-xl text-left transition-all duration-200",
                isDone && "cursor-pointer hover:bg-white/5",
                !isActive && !isDone && navigable && "cursor-pointer hover:bg-white/5",
                !navigable && "cursor-not-allowed",
                isPending && "opacity-60",
              )}
              style={{
                ...(isActiveDone ? {
                  background: "oklch(0.55 0.15 145 / 0.12)",
                  boxShadow: "inset 0 0 0 1px oklch(0.55 0.15 145 / 0.45)",
                } : isActive ? {
                  background: "oklch(0.72 0.25 285 / 0.12)",
                  boxShadow: "inset 0 0 0 1px oklch(0.72 0.25 285 / 0.25)",
                } : {}),
                ...(isHighlighted && !isActive ? {
                  boxShadow: "inset 0 0 0 1.5px oklch(0.72 0.25 285 / 0.55)",
                } : {}),
              }}
            >
              <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 transition-all"
                style={
                  isActiveDone ? {
                    background: "oklch(0.55 0.15 145 / 0.15)",
                    color: "oklch(0.55 0.15 145)",
                  } : isActive ? {
                    background: "oklch(0.72 0.25 285)",
                    color: "oklch(0.06 0 0)",
                    boxShadow: "0 0 14px oklch(0.72 0.25 285 / 0.5)",
                  } : isDone ? {
                    background: "transparent",
                    color: "oklch(0.55 0.15 145)",
                  } : {
                    background: "var(--bg-step-idle)",
                    color: "var(--c-38)",
                  }
                }
              >
                {isPending
                  ? <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  : isDone
                    ? <CheckCircle2 size={18} strokeWidth={2} />
                    : <Icon size={16} strokeWidth={1.75} />}
              </div>

              <div className="min-w-0">
                <p className={cn("text-sm font-semibold leading-tight",
                  isActive && "text-foreground",
                  isDone && "text-foreground/65",
                  status === "locked" && "text-foreground/25",
                )}>
                  {phase.label}
                </p>
                <p className={cn("text-xs leading-tight mt-0.5",
                  isActive ? "text-foreground/50" : "text-foreground/25",
                )}>
                  {phase.sublabel}
                </p>
              </div>

              {showStepCredits && stepCredits > 0 && (
                <span
                  className="ml-auto shrink-0 tabular-nums text-[11px] font-medium"
                  style={{ color: isActive ? "oklch(0.72 0.15 145)" : "oklch(0.62 0.12 145 / 0.75)" }}
                  title={`${phase.label} has charged ${stepCredits.toLocaleString(undefined, { maximumFractionDigits: 4 })} Heclus Credits on this video`}
                >
                  {stepCredits.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  <span style={{ marginLeft: "3px", opacity: 0.6 }}>cr</span>
                </span>
              )}
              {showStepUnits && primaryUnit && (
                <span
                  className="ml-auto shrink-0 tabular-nums text-[11px] font-medium"
                  style={{ color: isActive ? "oklch(0.72 0.15 145)" : "oklch(0.62 0.12 145 / 0.75)" }}
                  title={`${phase.label} on this video: ${Object.entries(stepUnits)
                    .map(([kind, units]) => `${units.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${unitSuffix(kind)}`)
                    .join(", ")}`}
                >
                  {compactNumber(stepUnits[primaryUnit])}
                  <span style={{ marginLeft: "3px", opacity: 0.6 }}>{unitSuffix(primaryUnit)}</span>
                </span>
              )}
            </button>

          </div>
        );
      })}
    </nav>
  );


  return (
    <>
      {/* ── Desktop top-left: Heclus logo (only when the sidebar is
            hidden — otherwise the logo lives inside the sidebar). */}
      {hideSteps && (
        <div className="hidden md:flex fixed top-4 left-4 z-50 items-center gap-1.5">
          <button onClick={() => router.push("/dashboard")} className="flex items-center gap-3 group">
            <div className="w-10 h-10 shrink-0 rounded-xl flex items-center justify-center">
              <Image src="/heclus-icon-white.svg" alt="Heclus" width={40} height={40} className="object-cover w-full h-full" />
            </div>
            <div className="min-w-0 text-left">
              <p className="text-sm font-bold text-foreground/90 group-hover:text-foreground transition-colors leading-tight">
                Heclus
              </p>
              {channelName && (
                <p className="text-xs leading-tight mt-0.5 truncate max-w-[180px]" style={{ color: "var(--c-45)" }}>
                  {channelName}
                </p>
              )}
            </div>
          </button>
          {/* Outside the button, not inside it: one button cannot hold
              another, and this one goes somewhere else entirely. */}
          {channelUrl && <CopyButton text={channelUrl} title="Copy channel URL" className="self-end mb-0.5" />}
        </div>
      )}

      {/* ── Desktop top-right: Back to Dashboard + Profile ──────────── */}
      <div className="hidden md:flex fixed top-4 right-4 z-50 items-center gap-2">
        {/* Admin only: render the app as either kind of account. A view held in
            this browser, which changes nothing about the account. Desktop row
            only; the mobile header has no room and this is a dev affordance. */}
        {isAdmin && (
          <div className="inline-flex rounded-lg overflow-hidden text-[11px] font-medium shrink-0"
            style={{ border: "1px solid var(--bd-8)" }}>
            {([["new", "New"], ["old", "Old"]] as const).map(([v, label]) => {
              const on = (planView ?? (isHeclusCreditsPlan(userPlan) ? "new" : "old")) === v;
              return (
                <button
                  key={v}
                  type="button"
                  disabled={switchingView}
                  onClick={async () => {
                    // The view switches first, so the buttons move under the
                    // cursor whether or not the write lands.
                    setAdminPlanView(v);
                    // And the funding mode follows it. Without this the switch
                    // rendered the credit-plan surfaces while every balance
                    // still came from the admin's own provider keys, which is
                    // what made "New" look broken.
                    setSwitchingView(true);
                    try {
                      await fetch("/api/admin/funding-mode", {
                        method: "PUT",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ mode: v === "new" ? "wallet" : "byo" }),
                      });
                      // Server components and every SWR bar read the mode, so
                      // the page has to re-fetch for the switch to show.
                      router.refresh();
                    } catch {
                      // The view still switched; only the funding half failed.
                    } finally {
                      setSwitchingView(false);
                    }
                  }}
                  title={v === "new" ? "View as a Heclus Credits account, funded by the wallet" : "View as an old-plan account, funded by your own keys"}
                  className="px-2 py-1.5 transition-all cursor-pointer disabled:opacity-60 disabled:cursor-wait"
                  style={on
                    ? { background: "oklch(0.72 0.25 285 / 0.18)", color: "var(--accent-purple-text)" }
                    : { background: "transparent", color: "var(--c-50)" }}
                >
                  {label}
                </button>
              );
            })}
          </div>
        )}
        {topRightExtra}
        <button
          onClick={() => router.push("/dashboard")}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80"
          style={{ background: "transparent", color: "var(--c-55)", border: "1px solid var(--bd-8)" }}
        >
          Dashboard
        </button>

        {/* Cost view — per-project provider × step breakdown. Hidden
            when this nav is rendered for the "new-fork" placeholder
            since there's no real project id to query against yet, and
            hidden on a credit plan, where the usage log reached from the
            Logs button beside the tips answers the same question in the
            unit that account is actually billed in. */}
        {projectId !== "new-fork" && !onCredits && (
          <button
            onClick={() => router.push(`/projects/${projectId}/cost`)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80"
            style={{ background: "transparent", color: "var(--c-55)", border: "1px solid var(--bd-8)" }}
          >
            <DollarSign size={13} />
            Cost
          </button>
        )}

        <ThemeToggle />

        {/* Profile avatar + dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowProfileMenu((v) => !v)}
            className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all hover:opacity-80 cursor-pointer shrink-0"
            style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
          >
            {userEmail ? userEmail[0].toUpperCase() : "?"}
          </button>

          {showProfileMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowProfileMenu(false)} />
              <div
                className="absolute right-0 top-10 z-50 w-60 rounded-2xl py-3 shadow-2xl"
                style={{ background: "var(--bg-card)", border: "1px solid oklch(1 0 0 / 0.1)" }}
              >
                <div className="px-4 pb-3 space-y-2" style={{ borderBottom: "1px solid oklch(1 0 0 / 0.07)" }}>
                  <p className="text-xs font-semibold truncate" style={{ color: "var(--c-88)" }}>
                    {userEmail || "Loading…"}
                  </p>
                  {showPlanPill && (
                    isAdmin ? (
                      <span className="inline-block text-[10px] font-semibold px-2.5 py-1 rounded-full capitalize"
                        style={{ background: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.65 0.15 145)", border: "1px solid oklch(0.55 0.15 145 / 0.25)" }}>
                        Admin
                      </span>
                    ) : (
                      <Link
                        href="/plan"
                        onClick={() => setShowProfileMenu(false)}
                        className="inline-block text-[10px] font-semibold px-2.5 py-1 rounded-full capitalize transition-opacity hover:opacity-75"
                        style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "var(--brand-text)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
                        {planLabel(isPaid ? userPlan : null)} plan →
                      </Link>
                    )
                  )}
                </div>
                <KieBalanceRow />
                <ElevenLabsBalanceRow />
                <div className="px-2 pt-2">
                  <button
                    onClick={() => { setShowProfileMenu(false); navigate("/setup"); }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition-all hover:opacity-80 cursor-pointer"
                    style={{ color: "var(--c-60)" }}
                  >
                    <Settings size={13} />
                    <span>Config</span>
                  </button>
                  <button
                    onClick={() => { setShowProfileMenu(false); navigate("/account"); }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition-all hover:opacity-80 cursor-pointer"
                    style={{ color: "var(--c-60)" }}
                  >
                    <KeyRound size={13} />
                    <span>Account</span>
                  </button>
                  <button
                    onClick={() => { setShowProfileMenu(false); navigate("/billing"); }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition-all hover:opacity-80 cursor-pointer"
                    style={{ color: "var(--c-60)" }}
                  >
                    <Wallet size={13} />
                    <span>Billing</span>
                  </button>
                  <button
                    onClick={() => { setShowProfileMenu(false); handleSignOut(); }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition-all hover:opacity-80 cursor-pointer"
                    style={{ color: "#f87171" }}
                  >
                    <LogOut size={13} />
                    <span>Sign Out</span>
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── Mobile top bar + step line (fixed, 92px; pages offset by it) ── */}
      <div
        className="md:hidden fixed top-0 inset-x-0 z-[200] flex flex-col shrink-0"
        style={{ background: "var(--bg-nav)", borderBottom: "1px solid var(--bd-7)" }}
      >
        {/* Logo row */}
        <div className="h-14 flex items-center justify-between px-4 gap-2">
          <button onClick={() => router.push("/dashboard")} className="flex items-center gap-2 min-w-0">
            <div className="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center">
              <Image src="/heclus-icon-white.svg" alt="Heclus" width={28} height={28} className="object-cover w-full h-full" />
            </div>
            <span className="text-sm font-bold" style={{ color: "var(--c-90)" }}>Heclus</span>
          </button>

          <div className="flex items-center gap-2 shrink-0">
            {topRightExtra}
            <button
              onClick={() => router.push("/dashboard")}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80"
              style={{ color: "var(--c-55)", border: "1px solid var(--bd-8)" }}
            >
              Dashboard
            </button>
            {/* Cost view (mobile) — icon-only to save horizontal space
                next to Back, Theme, and the profile avatar. Skipped on
                the "new-fork" placeholder since there's no project yet. */}
            {projectId !== "new-fork" && (
              <button
                onClick={() => router.push(`/projects/${projectId}/cost`)}
                aria-label="Cost breakdown"
                className="flex items-center justify-center w-8 h-8 rounded-lg transition-all hover:opacity-80"
                style={{ color: "var(--c-55)", border: "1px solid var(--bd-8)" }}
              >
                <DollarSign size={14} />
              </button>
            )}
            <ThemeToggle />

            {/* Profile avatar + dropdown */}
            <div className="relative">
              <button
                onClick={() => setShowProfileMenu((v) => !v)}
                className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold transition-all hover:opacity-80 cursor-pointer shrink-0"
                style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
              >
                {userEmail ? userEmail[0].toUpperCase() : "?"}
              </button>

              {showProfileMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowProfileMenu(false)} />
                  <div
                    className="absolute right-0 top-10 z-50 w-60 rounded-2xl py-3 shadow-2xl"
                    style={{ background: "var(--bg-card)", border: "1px solid oklch(1 0 0 / 0.1)" }}
                  >
                    <div className="px-4 pb-3 space-y-2" style={{ borderBottom: "1px solid oklch(1 0 0 / 0.07)" }}>
                      <p className="text-xs font-semibold truncate" style={{ color: "var(--c-88)" }}>
                        {userEmail || "Loading…"}
                      </p>
                      {showPlanPill && (
                        isAdmin ? (
                          <span className="inline-block text-[10px] font-semibold px-2.5 py-1 rounded-full capitalize"
                            style={{ background: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.65 0.15 145)", border: "1px solid oklch(0.55 0.15 145 / 0.25)" }}>
                            Admin
                          </span>
                        ) : (
                          <Link
                            href="/plan"
                            onClick={() => setShowProfileMenu(false)}
                            className="inline-block text-[10px] font-semibold px-2.5 py-1 rounded-full capitalize transition-opacity hover:opacity-75"
                            style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "var(--brand-text)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
                            {planLabel(isPaid ? userPlan : null)} plan →
                          </Link>
                        )
                      )}
                    </div>
                    <KieBalanceRow />
                    <ElevenLabsBalanceRow />
                    <div className="px-2 pt-2">
                      <button
                        onClick={() => { setShowProfileMenu(false); router.push("/setup"); }}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition-all hover:opacity-80 cursor-pointer"
                        style={{ color: "var(--c-60)" }}
                      >
                        <Settings size={13} />
                        <span>Config</span>
                      </button>
                      <button
                        onClick={() => { setShowProfileMenu(false); router.push("/account"); }}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition-all hover:opacity-80 cursor-pointer"
                        style={{ color: "var(--c-60)" }}
                      >
                        <KeyRound size={13} />
                        <span>Account</span>
                      </button>
                      <button
                        onClick={() => { setShowProfileMenu(false); router.push("/billing"); }}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition-all hover:opacity-80 cursor-pointer"
                        style={{ color: "var(--c-60)" }}
                      >
                        <Wallet size={13} />
                        <span>Billing</span>
                      </button>
                      <button
                        onClick={() => { setShowProfileMenu(false); handleSignOut(); }}
                        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition-all hover:opacity-80 cursor-pointer"
                        style={{ color: "#f87171" }}
                      >
                        <LogOut size={13} />
                        <span>Sign Out</span>
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        {/* Where you are, and the way to everywhere else, on one line. This
            row used to be nine 4px dots with a label floating under them: the
            dots opened the drawer, which is what a menu button does, and they
            were unreadable at that size. */}
        {!hideSteps && (
          <div className="h-9 flex items-center gap-2 px-4" style={{ borderTop: "1px solid var(--bd-6)" }}>
            <button
              onClick={() => setDrawerOpen(true)}
              aria-label="Open the workflow steps"
              className="flex min-w-0 flex-1 items-center gap-2 text-left transition-opacity hover:opacity-80"
              style={{ color: "var(--c-60)" }}
            >
              <Menu size={19} className="shrink-0" />
              {(() => {
                const active = PHASES.find((p) => getPhaseStatus(p) === "active");
                if (!active) return <span className="text-xs">Steps</span>;
                return (
                  <span className="text-xs truncate">
                    <span className="font-semibold" style={{ color: "var(--brand-text)" }}>{active.label}</span>
                    <span style={{ color: "var(--c-40)" }}> · {active.sublabel}</span>
                  </span>
                );
              })()}
            </button>
            {/* The usage log, where a phone has room for it. The header's own
                Logs button is hidden below md, so it is here rather than
                twice. */}
            {onCredits && projectId !== "new-fork" && (
              <Link
                href={`/projects/${projectId}/logs`}
                title="Credit usage log"
                className="shrink-0 inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] font-medium transition-opacity hover:opacity-80"
                style={{ border: "1px solid var(--bd-8)", color: "var(--c-55)" }}
              >
                <ScrollText size={12} />
                <span>Logs</span>
              </Link>
            )}
          </div>
        )}
      </div>

      {/* ── Mobile drawer ───────────────────────────────────────────── */}
      {!hideSteps && drawerOpen && (
        <div className="md:hidden fixed inset-0 z-[300]">
          <div className="absolute inset-0 bg-black/60" onClick={closeDrawer} />
          <div
            className="absolute top-0 left-0 bottom-0 w-72 flex flex-col"
            style={{ background: "var(--bg-nav)", borderRight: "1px solid var(--bd-7)" }}
          >
            <div className="px-5 py-5 flex items-center justify-between border-b" style={{ borderColor: "var(--bd-7)" }}>
              <Link href="/dashboard" className="flex items-center gap-3 transition-opacity hover:opacity-80">
                <div className="w-9 h-9 shrink-0 rounded-xl flex items-center justify-center">
                  <Image src="/heclus-icon-white.svg" alt="Heclus" width={36} height={36} className="object-cover w-full h-full" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-bold leading-tight" style={{ color: "var(--c-90)" }}>Heclus</p>
                  {channelName && (
                    <p className="text-xs leading-tight mt-0.5 truncate max-w-[140px]" style={{ color: "var(--c-45)" }}>
                      {channelName}
                    </p>
                  )}
                </div>
              </Link>
              {channelUrl && <CopyButton text={channelUrl} title="Copy channel URL" className="ml-1.5 self-end mb-0.5" />}
              <button
                onClick={closeDrawer}
                className="p-1.5 rounded-lg transition-all hover:opacity-80 shrink-0"
                style={{ color: "var(--c-50)", background: "var(--bg-progress)", border: "1px solid var(--bd-8)" }}
              >
                <X size={16} />
              </button>
            </div>
            {stepList}
          </div>
        </div>
      )}

      {/* ── Desktop sidebar ──────────────────────────────────────────── */}
      {!hideSteps && (
        <aside className="hidden md:flex w-64 shrink-0 flex-col h-screen sticky top-0 overflow-hidden"
          style={{ background: "var(--bg-nav)", borderRight: "1px solid var(--bd-7)" }}>

          <div className="px-5 py-5 border-b flex items-center gap-1.5" style={{ borderColor: "var(--bd-7)" }}>
            <button onClick={() => router.push("/dashboard")} className="flex items-center gap-3 group min-w-0 flex-1">
              <div className="w-10 h-10 shrink-0 rounded-xl flex items-center justify-center">
                <Image src="/heclus-icon-white.svg" alt="Heclus" width={40} height={40} className="object-cover w-full h-full" />
              </div>
              <div className="min-w-0 text-left">
                <p className="text-sm font-bold text-foreground/90 group-hover:text-foreground transition-colors leading-tight">
                  Heclus
                </p>
                <p className="text-xs leading-tight mt-0.5" style={{ color: "var(--c-45)" }}>
                  {channelName ? (
                    <span className="truncate block max-w-[140px]">{channelName}</span>
                  ) : "Heclus"}
                </p>
              </div>
            </button>
            {/* Beside the name it belongs to, and outside the button that
                carries you back to the dashboard. */}
            {channelUrl && <CopyButton text={channelUrl} title="Copy channel URL" className="self-end mb-0.5" />}
          </div>

          {stepList}
        </aside>
      )}
    </>
  );
}
