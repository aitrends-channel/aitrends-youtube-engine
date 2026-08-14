import type { KieModel } from "@/lib/types";

// Which models are free-tier, in one place.
//
// A free model is Heclus-funded and metered against the credit wallet, so it is
// offered through exactly one route: the Free tab of the model picker. Every
// other selector filters it out, for two reasons.
//
// One is presentation: listed beside paid models it reads as just another
// option, and at the bottom of a long list it is invisible.
//
// The other is correctness. A free clip has to be queued into the parking
// status the shared video-worker cannot claim, and only the studio queue route
// does that. The 1Click orchestrator queues into "queued" like any KIE clip, so
// a free model selected there would be handed to KIE and fail. Keeping the
// option out of that surface is what makes the difference impossible to hit.
export const FREE_MODEL_TAG = "free";

export function isFreeTierModel(m: Pick<KieModel, "tags">): boolean {
  return (m.tags ?? []).some((t) => t.toLowerCase() === FREE_MODEL_TAG);
}

/** Everything except the free-tier models. */
export function paidModelsOnly<T extends Pick<KieModel, "tags">>(models: T[] | undefined | null): T[] {
  return (models ?? []).filter((m) => !isFreeTierModel(m));
}
