// KILL-SWITCH for the free tier (Qwen + BYO Google voiceover, BYO
// Cloudflare images). While true, every Free tab/sub-tab shows the
// "coming soon" tag and placeholder card instead of the live pickers,
// usage bars, and setup fields. All functional free-tier code stays in
// place behind this flag.
// Temporarily back on for the production release; the free tier ships
// in a later promotion once it's ready to go live.
export const FREE_TIER_COMING_SOON = true;
