// The GenAIPro lane's queued status, in a leaf module so client components can
// import it without pulling in lib/genaipro/client.ts, which reaches for the
// product key and the service-role Supabase client.
//
// It is a parking status, not a user-facing word: the shared video-worker claims
// anything sitting in "queued", so GenAIPro beats wait somewhere that worker
// will not touch. That makes it an implementation detail the UI has to translate
// rather than print, and it has to count as in-flight everywhere "queued" does.
export const GENAIPRO_QUEUED_STATUS = "gp_queued";

/** Statuses that mean the clip is on its way: the tile should spin, the regen
 *  button should be disabled, and the poller should be running. */
export function isVideoInFlight(status: string | null | undefined): boolean {
  return status === GENAIPRO_QUEUED_STATUS
    || status === "queued" || status === "submitting" || status === "rendering";
}

/** What the status badge shows. Only the free lane needs translating; every
 *  other status is already the word we want the user to read. */
export function videoStatusLabel(status: string | null | undefined): string {
  return status === GENAIPRO_QUEUED_STATUS ? "queued" : (status ?? "");
}

/** Prefix every GenAIPro model id carries. Defined here, not in client.ts,
 *  so client components can test against it without pulling the provider
 *  client in. client.ts re-exports it for server callers. */
export const GENAIPRO_MODEL_PREFIX = "genaipro";

/** Whether this model runs on the free lane. */
export function isGenAIProModel(modelId: string | null | undefined): boolean {
  return !!modelId && modelId.toLowerCase().startsWith(GENAIPRO_MODEL_PREFIX);
}
