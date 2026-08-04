// Bulk-mail template defaults + shared audience metadata. Client-safe
// (no supabase import) so the admin panel can render instantly and the
// templates API can fall back to these when the bulk_mail_templates
// table is missing or empty (migration 094 not applied yet).
//
// Tokens supported in subject/body — substituted per recipient at
// send/preview time by personalizeBulkMail:
//   {{name}}  → recipient's first name ("there" when unknown)
//   {{video}} → "video"/"videos" by the recipient's matching count
//   {{stuck}} → audience-aware sentence, see stuckLineFor()

export interface BulkMailTemplate {
  id: string;
  label: string;
  subject: string;
  body: string;
  videoTable: boolean;
  sortOrder: number;
}

// Wizard step audiences (ids must match lib/admin/bulk-mail-audience's
// STUCK_PHASES). Shared here so the panel and {{stuck}} resolution use
// one list.
export const BULK_MAIL_STEP_OPTIONS = [
  { id: "channel",    label: "Channel setup" },
  { id: "topic",      label: "Topic" },
  { id: "script",     label: "Script" },
  { id: "visuals",    label: "Visuals" },
  { id: "prompts",    label: "Prompts" },
  { id: "voiceover",  label: "Voiceover" },
  { id: "generate",   label: "Generate" },
  { id: "assemble",   label: "Assemble" },
  { id: "thumbnails", label: "Thumbnails" },
] as const;

// Customer-level audiences (ids must match CUSTOMER_AUDIENCES in
// lib/admin/bulk-mail-audience). Client-safe so the panel can build the
// picker, decide when to hide the idle selector, and label history rows
// without importing the server-only audience module.
export const BULK_MAIL_CUSTOMER_OPTIONS = [
  {
    id: "paid-no-setup",
    label: "Paid users with no setup",
    historyLabel: "Paid, no setup",
    hint: "Paying customers who haven't finished account setup (no API key saved) — no idle window, matched regardless of last activity.",
  },
  {
    id: "paid-setup-no-video",
    label: "Paid users with setup but zero video",
    historyLabel: "Paid, no niche",
    hint: "Paying customers with account setup done but no niche created yet (no channel analyzed) — no idle window.",
  },
  {
    id: "free-inactive-3d",
    label: "Free/demo users with no activity in the past 3 days",
    historyLabel: "Free/demo inactive 3d+",
    hint: "Free or demo users (never paid) with no sign-in and no project activity in the past 3 days — includes accounts that never did anything.",
  },
  {
    id: "all-paid",
    label: "All paid users",
    historyLabel: "All paid users",
    hint: "Every paying account, whatever their funnel position — no idle window. Admin and test accounts are always excluded.",
  },
  {
    id: "all-users",
    label: "All users",
    historyLabel: "All users",
    hint: "Every account — paid, free and demo — with no funnel filter and no idle window. Admin and test accounts are always excluded.",
  },
] as const;

export function isCustomerAudienceId(v: string): boolean {
  return BULK_MAIL_CUSTOMER_OPTIONS.some((o) => o.id === v);
}

// The {{stuck}} sentence for a given audience. Step audiences name the
// step; everything else ("any", the paid audiences) gets the generic
// unfinished-video line.
export function stuckLineFor(phase: string): string {
  const step = BULK_MAIL_STEP_OPTIONS.find((p) => p.id === phase);
  return step
    ? `I noticed your video has been stuck at the ${step.label.toLowerCase()} step for a while.`
    : "I noticed you started a video that hasn't been finished yet.";
}

export const DEFAULT_BULK_MAIL_TEMPLATES: BulkMailTemplate[] = [
  {
    id: "checkin",
    label: "Support check-in",
    subject: "Checking in on your Heclus {{video}}",
    body: `Hi {{name}},

I'm Alex from the Heclus support team. {{stuck}}

Did you run into any issues there? Just reply and let me know what got in the way. Happy to help you finish it.

Thanks,
Alex
Heclus Support`,
    videoTable: true,
    sortOrder: 0,
  },
  {
    id: "nudge",
    label: "Re-engagement nudge",
    subject: "Your Heclus {{video}} is almost there",
    body: `Hi {{name}},

Your {{video}} is saved exactly where you left off - nothing is lost.

Most videos take just a few more minutes to finish once the pipeline is running again. Jump back in and Heclus picks up from the step you stopped at.

If anything got in the way, just reply and I'll help you through it.

Thanks,
Alex
Heclus Support`,
    videoTable: true,
    sortOrder: 1,
  },
  {
    id: "founder",
    label: "Founder offer",
    subject: "A full year of Heclus for $40",
    body: `Hi {{name}},

Since you have a {{video}} in progress, I wanted to make sure you saw this before it's gone: the Founder offer - a full year of Heclus for a one-time $40. Everything in Starter, 20 niches for the year, no monthly renewal.

It's limited to the first 100 creators and spots are running low.

You can claim it at https://heclus.com/pricing.

Thanks,
Alex
Heclus Support`,
    videoTable: false,
    sortOrder: 2,
  },
  {
    id: "paid-no-setup",
    label: "Paid: finish account setup",
    subject: "One step left to unlock your Heclus plan",
    body: `Hi {{name}},

Thanks for joining Heclus - your plan is active, but your account setup isn't finished yet, so none of it is working for you.

It's one quick step: open the Setup page, add your API key (the page walks you through getting it), and you're live. From there your first video is as simple as pasting a YouTube channel URL - the pipeline handles the script, voiceover, images, video clips, and thumbnails.

If anything about the setup is unclear, reply to this email and I'll walk you through it personally. I read every response.

Thanks,
Alex
Heclus Support`,
    videoTable: false,
    sortOrder: 3,
  },
  {
    id: "paid-setup-no-video",
    label: "Paid: start first niche",
    subject: "Your account is ready - your first video takes about two minutes",
    body: `Hi {{name}},

Your account is fully set up - the only thing missing is your first niche.

Here's all it takes: paste any YouTube channel URL and Heclus analyzes it, then generates the script, voiceover, images, video clips, and thumbnails for you. A couple of minutes of your time, and your plan starts earning its keep.

Not sure which channel to start with? Reply with your topic and I'll suggest a good niche to clone.

Thanks,
Alex
Heclus Support`,
    videoTable: false,
    sortOrder: 4,
  },
  {
    id: "service-outage",
    label: "Service notice: KIE outage",
    subject: "Why your generations are failing right now",
    body: `Hi {{name}},

If your generations have been failing, it isn't your setup and it isn't your API key. KIE - the provider Heclus routes generation through - is having an internal outage and is returning "Server exception, please try again later" on their side.

What that means for you:

- Script, prompt, image, voiceover and video steps can fail or stall while the outage lasts.
- Nothing you have made is lost. Every project stays exactly at the step it reached, and you can carry on from there once KIE recovers.
- Retrying straight away will usually hit the same error, so it is worth giving it some time rather than repeating the step.

We are watching KIE's status and the pipeline will pick up again as soon as their service is back. If this runs on longer than expected, I will email you an update.

Sorry for the disruption. If you are stuck on something specific, reply to this email and I will look at your account directly.

Thanks,
Alex
Heclus Support`,
    videoTable: false,
    sortOrder: 5,
  },
];
