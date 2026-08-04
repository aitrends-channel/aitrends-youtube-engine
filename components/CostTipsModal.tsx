"use client";

import { useState } from "react";
import { Lightbulb } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { FREE_TTS_COMING_SOON } from "@/lib/free-tier-flag";

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
        body: "Voiceover is the next biggest line after images, at around 6 credits per run on ElevenLabs. The free voices included with Heclus cost no credits at all, so unless a project needs a specific premium voice, this is close to free money.",
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
// Measured from project_costs: image generation (incl. thumbnails) ~64% of
// all KIE credits spent, voiceover ~30%, and every Claude text step plus
// video clips the remainder. Drives both the bar and the tip ordering.
const SPEND_SPLIT = [
  { label: "Images", pct: 64, color: "#8b6cf7" },
  { label: "Voiceover", pct: 30, color: "#f0a855" },
  { label: "Everything else", pct: 6, color: "#d4d4d8" },
];

export function CostTipsModal() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Tips to cut cost"
        aria-label="Tips to cut cost"
        className="inline-flex items-center gap-1.5 rounded-md text-xs font-medium px-2.5 py-1 transition-all hover:opacity-80 cursor-pointer max-w-full lg:ml-10"
        style={{
          border: "1px solid oklch(0.65 0.15 145 / 0.35)",
          background: "oklch(0.65 0.15 145 / 0.10)",
          color: "oklch(0.65 0.15 145)",
        }}
      >
        <Lightbulb size={12} />
        <span>Tips to cut cost</span>
      </button>

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
                Images and voiceover drive almost all of your spend, and the first three tips cost nothing to apply.{" "}
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
