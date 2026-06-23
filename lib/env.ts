// Single source of truth for "is this the live customer-facing
// deployment?" Used by admin aggregates to strip admin self-activity
// from production stats and by the Launch endpoint to refuse running
// outside prod.
//
// Vercel's NODE_ENV and VERCEL_ENV are both "production" on the
// staging project too (because `staging` is configured as that
// project's production branch), so they can't distinguish. Two env
// vars must be set ONLY on the live aitrends-youtube-engine project's
// Production scope:
//
//   HECLUS_ENV=production              # server-side checks
//   NEXT_PUBLIC_HECLUS_ENV=production  # client-side UI gating
//
// Local dev (.env.local) and the heclus-staging Vercel project leave
// both unset, which falls through to "not production".
//
// The two-var split is unfortunate but unavoidable: NEXT_PUBLIC_*
// vars are inlined into the client bundle at build time, while
// the non-prefixed one is server-only. Keep them in lockstep when
// updating Vercel.

export function isProductionEnv(): boolean {
  return process.env.HECLUS_ENV === "production";
}

export function isProductionEnvClient(): boolean {
  return process.env.NEXT_PUBLIC_HECLUS_ENV === "production";
}

// Returns true on the live prod deployment AND on local `yarn dev`.
// Used to gate the Launch action: prod is the real target; local dev
// gets to fire it so we can test the destructive flow safely (it'll
// hit the dev DB + staging R2 configured in .env.local).
// Vercel-deployed staging stays excluded because there NODE_ENV is
// "production" but HECLUS_ENV is unset.
export function launchAllowed(): boolean {
  return isProductionEnv() || process.env.NODE_ENV === "development";
}

export function launchAllowedClient(): boolean {
  return isProductionEnvClient() || process.env.NODE_ENV === "development";
}
