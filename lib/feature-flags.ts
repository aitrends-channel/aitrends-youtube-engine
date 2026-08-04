// Kill-switches for features that ship dark. Flipping one is a one-line
// change plus a deploy — no config, no DB.
//
// (The free-tier switches predate this file and still live in
// lib/free-tier-flag.ts.)

// Beat merging on the prompts step — the per-beat ↑/↓ controls, the short-beat
// badge and the bulk "Merge beats" dialog.
export const MERGE_BEATS_HIDDEN = true;

// 1Click autopilot. Hides the Studio-vs-1Click chooser (New niche and New
// video go straight to Studio), the Setup tab, the per-project controls, and
// bounces the /one-click routes back to the dashboard. The API routes and the
// cron tick stay in place — nothing can reach them to start a run, and no
// existing project has auto_pilot set.
export const ONE_CLICK_HIDDEN = true;
