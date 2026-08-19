// KILL-SWITCH for the free tier (Qwen + BYO Google voiceover, BYO
// Cloudflare images). While true, every Free tab/sub-tab shows the
// "coming soon" tag and placeholder card instead of the live pickers,
// usage bars, and setup fields. All functional free-tier code stays in
// place behind this flag.
// Back on while the free tier bakes; the launch is a one-line flip.
// Governs the free IMAGE tier (BYO Cloudflare) — still coming soon.
export const FREE_TIER_COMING_SOON = true;

// Free VOICEOVER (TTS) tier kill-switch, separate from images so TTS can
// launch on its own. Currently LIVE (false) and scoped to the ai33 perk —
// the other free voiceover providers (Qwen, BYO Google) are hidden from
// the Free tab while this ships.
export const FREE_TTS_COMING_SOON = false;

// Free VIDEO tier kill-switch, separate again so video can launch on its own.
// Covers the GenAIPro credit wallet, not a BYO key: while true, monthlyGrantFor
// and getCreditBalance report an empty wallet for EVERY account, admins
// included. That is what hides the Balance section on the account page, the
// credits panel and Top up button on the Generate step, and the free model in
// the picker, which falls back to the "coming soon" tab and teaser card.
//
// Bought credits are hidden, not destroyed: the wallet rows stay in the
// database and reappear when this flips. The reserve and settle paths are
// deliberately left alone so anything already queued can still finish.
//
// OFF while GenAIPro is brought up. That does NOT put the feature in front of
// customers: VIDEO_CREDITS_ADMIN_ONLY in lib/credits.ts still zeroes a
// non-admin's allowance, so the Free tab on the Generate step is live for
// admins and stays a coming-soon teaser for everyone else. Turning it on for
// customers means flipping that second flag, which is a spend decision:
// starter and pro carry 300 clips a month each from QUOTA_DEFAULTS, at $0.02
// a clip of Heclus's money.
export const FREE_VIDEO_COMING_SOON = false;
