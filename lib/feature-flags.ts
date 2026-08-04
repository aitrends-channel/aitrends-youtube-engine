// Kill-switches for features that ship dark. Flipping one is a one-line
// change plus a deploy — no config, no DB.
//
// (The free-tier switches predate this file and still live in
// lib/free-tier-flag.ts.)

// Beat merging on the prompts step — the per-beat ↑/↓ controls, the short-beat
// badge and the bulk "Merge beats" dialog.
export const MERGE_BEATS_HIDDEN = false;

// Automatic welcome email on a first-time plan purchase (lib/email/welcome).
// Off means purchases grant access exactly as before, silently.
export const WELCOME_EMAIL_ENABLED = true;

// 1Click autopilot. Hides the Studio-vs-1Click chooser (New niche and New
// video go straight to Studio), the Setup tab, the per-project controls, and
// bounces the /one-click routes back to the dashboard. The API routes and the
// cron tick stay in place — nothing can reach them to start a run, and no
// existing project has auto_pilot set.
export const ONE_CLICK_HIDDEN = true;

// Three-step prompts flow: beats (segmentation only) → image prompts → video
// prompts, instead of today's two steps where segmentation and image prompts
// come from one Claude call.
//
// The point is the gap in the middle: beats exist before any prompt does, so
// merging stub beats there costs nothing. Merging AFTER prompts exist means
// the surviving beat keeps a prompt written for its old, shorter segment —
// wrong text — and fixing that means paying to rewrite it.
//
// Ships dark until the new path has been exercised against a live provider.
export const PROMPTS_THREE_STEP = false;
