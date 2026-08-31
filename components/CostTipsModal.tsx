"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState, useEffect } from "react";
import { Lightbulb, ScrollText } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { FREE_TTS_COMING_SOON } from "@/lib/free-tier-flag";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { useOnCreditsPlan } from "@/lib/admin-view";

// Mirrors the website's "How do I keep my generation costs down?" answer
// (heclus-landing-page lib/faq-data.ts) so support, the marketing site and
// the app all say the same thing. If that answer changes, change this too.
//
// Order leads with the three levers that cost nothing to apply: stop wasting
// generations, pick a cheaper model, drop animation you do not need. Credit
// figures come from model_cost_and_speed — keep them in step with that table,
// since a wrong number here is worse than no number.
const TIPS: { title: string; body: string }[] = [
  {
    title: "Avoid unnecessary regenerations",
    body: "Every regeneration is charged again in full, so a habit of re-rolling for a marginal improvement quietly doubles the bill. Read your prompt before running it, generate one beat to check the look before committing to the whole set, and accept a good frame rather than chasing a perfect one.",
  },
  {
    title: "Avoid expensive image and video models when not necessary",
    body: "Every image and video step prints each model's cost on the card and sorts cheapest first. The spread is more than twentyfold: z-image costs 0.8 credits per image, against 18 for nano-banana-pro. Run a premium model on the hook or a hero shot, and a budget one everywhere else.",
  },
  {
    title: "For content that does not need animation, assemble with images only",
    body: "With video generation off, the project assembles from stills: one AI image held for the length of its narration beat, with no video-model spend at all. In our own project data, going images-only and choosing the cheapest image models together cut the cost of a video by roughly 70%.",
  },
  {
    title: "Set your prompt prefix once",
    body: "Locking your style in from the first generation keeps scenes consistent. Re-rolling images to fix drift is a large share of what people spend.",
  },
  ...(FREE_TTS_COMING_SOON
    ? []
    : [{
        title: "Use Heclus Free Resources",
        body: "The free voices included with Heclus cost no credits at all, against around 6 credits per run on ElevenLabs. Voiceover is a small part of a typical bill, so treat this as tidying up rather than the main saving.",
      }]),
  {
    title: "Retry failed beats, not the whole step",
    body: "You are not charged for failed generations, and Retry requeues only the beats that failed rather than starting the step over. If one image came out wrong, edit that beat's prompt and regenerate just that beat.",
  },
  {
    title: "Watch the numbers as you go",
    body: "Each step shows what it cost and your remaining provider balance in the same view, so you can course-correct mid-project instead of finding out at the end.",
  },
];

// Renders as a pill in each step's cost/balance row, matching StepCostCard
// and StepBalanceCard: same rounded-md, text-xs, px-2.5 py-1 geometry, so the
// three sit on one line without one of them looking taller or louder. The
// 40px left gap is lg-only: once the row wraps on narrow screens, an indent
// on the wrapped pill reads as a misalignment rather than separation.
// Measured over every project_costs row (99k rows, 112.5k credits), NOT a
// sample — an earlier version of this used a truncated query and badly
// overstated voiceover. Images 86%, video clips 8%, voiceover 2%, all
// prompt/text steps together under 4%.
const SPEND_SPLIT = [
  { label: "Images", pct: 86, color: "#8b6cf7" },
  { label: "Video clips", pct: 8, color: "#f0a855" },
  { label: "Everything else", pct: 6, color: "#d4d4d8" },
];

export function CostTipsModal() {
  const [open, setOpen] = useState(false);
  // Credit-funded accounts get a way into the usage log from wherever they are.
  // Read off the auth metadata rather than fetched: it is already in the
  // session, and this component renders on nine pages.
  const [plan, setPlan] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    void supabase.auth.getUser().then(({ data }) => {
      const meta = (data.user?.app_metadata ?? {}) as { plan?: unknown; is_admin?: unknown };
      if (typeof meta.plan === "string") setPlan(meta.plan);
      if (meta.is_admin === true) setIsAdmin(true);
    });
  }, []);
  // Follows the admin switch in the wizard header, so flipping to Old hides
  // this the way it is hidden for an account that really is on an old plan.
  const onCredits = useOnCreditsPlan(plan, isAdmin);
  // The log lives under the project, so the wizard nav has something to render
  // beside it. Without a project in the URL there is nothing to link to.
  const params = useParams<{ projectId?: string }>();
  const projectId = typeof params?.projectId === "string" ? params.projectId : null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Tips to cut cost"
        aria-label="Tips to cut cost"
        // Full width on phones, centred: the pill was landing on its own line
        // under the cost chips anyway (the row wraps), so a narrow left-aligned
        // button just left a ragged gap. From sm up it goes back to hugging its
        // label so it can sit inline beside the chips.
        className="inline-flex shrink-0 items-center gap-1.5 rounded-md text-xs font-medium px-2.5 py-1 transition-all hover:opacity-80 cursor-pointer max-w-full w-full justify-center sm:w-auto sm:justify-start lg:ml-10"
        style={{
          border: "1px solid oklch(0.65 0.15 145 / 0.35)",
          background: "oklch(0.65 0.15 145 / 0.10)",
          color: "oklch(0.65 0.15 145)",
        }}
      >
        <Lightbulb size={12} />
        <span>Tips to cut cost</span>
        <span
          className="rounded-[4px] px-1 py-px text-[9px] font-bold uppercase tracking-wider leading-[1.4]"
          style={{ background: "oklch(0.6 0.22 25 / 0.12)", color: "oklch(0.62 0.22 25)" }}
        >
          New
        </span>
      </button>

      {/* Beside the tips, because the two answer the same question from
          opposite ends: how to spend less, and what has been spent. */}
      {onCredits && projectId && (
        <Link
          href={`/projects/${projectId}/logs`}
          title="Credit usage log"
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md text-xs font-medium px-2.5 py-1 transition-all hover:opacity-80 cursor-pointer"
          style={{
            border: "1px solid var(--bd-8)",
            background: "transparent",
            color: "var(--c-55)",
          }}
        >
          <ScrollText size={12} />
          <span>Logs</span>
        </Link>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        {/* p-0 + gap-0 so the header, list and footer own their own padding
            and can carry full-width dividers. DialogContent already supplies
            bg-white / zinc text / ring. */}
        <DialogContent className="sm:max-w-2xl p-0 gap-0 max-h-[90dvh] sm:max-h-[85vh] overflow-y-auto">
          <div className="px-5 pt-5 pb-4 pr-12 sm:px-7 sm:pt-6 sm:pb-5 border-b border-zinc-100">
            <DialogHeader className="gap-1.5">
              <DialogTitle className="text-[17px] sm:text-[19px] font-semibold tracking-tight text-zinc-900">
                Tips to cut generation cost by 50%
              </DialogTitle>
              <DialogDescription className="text-[13px] leading-relaxed text-zinc-500">
                Images are the overwhelming majority of your spend, and the first three tips cost nothing to apply.{" "}
                <span className="font-semibold text-zinc-700">We provide the tool, you control cost.</span>
              </DialogDescription>
            </DialogHeader>

            {/* Where the credits actually go, measured from project_costs
                across projects on Heclus. Keep the split and the legend in
                step with that query. */}
            <div className="mt-5">
              <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-zinc-100">
                {SPEND_SPLIT.map((seg) => (
                  <div key={seg.label} style={{ width: `${seg.pct}%`, background: seg.color }} />
                ))}
              </div>
              <div className="mt-2.5 flex flex-wrap gap-x-4 sm:gap-x-5 gap-y-1.5">
                {SPEND_SPLIT.map((seg) => (
                  <span key={seg.label} className="inline-flex items-center gap-1.5 text-[11px] text-zinc-500">
                    <span className="h-2 w-2 rounded-full" style={{ background: seg.color }} />
                    {seg.label} <span className="font-semibold text-zinc-700">{seg.pct}%</span>
                  </span>
                ))}
              </div>
            </div>
          </div>

          <ol className="divide-y divide-zinc-100">
            {TIPS.map((tip, i) => (
              <li key={tip.title} className="flex gap-3 sm:gap-4 px-5 py-4 sm:px-7 sm:py-[18px]">
                <span
                  aria-hidden
                  className="mt-px flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold"
                  style={{ background: "#ecfdf5", color: "#047857" }}
                >
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-[13.5px] font-semibold text-zinc-900">{tip.title}</p>
                  <p className="mt-1 text-[13px] leading-[1.7] text-zinc-600">{tip.body}</p>
                </div>
              </li>
            ))}
          </ol>

          <div className="border-t border-zinc-100 bg-zinc-50 px-5 py-3.5 sm:px-7 sm:py-4">
            <p className="text-[12px] leading-relaxed text-zinc-500">
              Every image and video step shows its own cost and your live provider balance, so you can see the effect of any of these changes straight away.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
