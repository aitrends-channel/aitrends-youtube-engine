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
