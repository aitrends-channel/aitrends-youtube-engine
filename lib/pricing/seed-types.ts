/**
 * Seed prices: what a generation costs before the ledger has measured it.
 *
 * The estimate's first choice has always been a figure measured for that exact
 * model and resolution. Where none existed it scaled a blended average by the
 * resolution ladder in ./resolution.ts, which assumes price tracks pixel count.
 * That assumption is wrong on most models: Nano Banana 2 charges the same at 1K
 * and 2K, Seedream 4 charges the same at all three.
 *
 * So there is a table instead, in two halves:
 *
 *   generated  written from model_cost_and_speed by scripts/seed-model-prices.mjs.
 *              Real billing data, and the better source, since it is what the
 *              vendor actually took rather than what it advertises.
 *   manual     hand-entered from published pricing, for models nobody has run
 *              yet. The only way to have a figure for a model with no history.
 *
 * Generated wins where both have a row: a measured figure beats a published one.
 * Manual exists to fill the gaps, not to correct the measurements.
 */

/** Credits for one unit. Images are per generation, video is per second. */
export interface SeedPrice {
  /** The figure when the model has no resolution control, and the fallback
   *  when it has one but this resolution is not listed. */
  flat?: number;
  /** Per resolution, in the vendor's own credit. */
  byResolution?: Record<string, number>;
}

export type SeedKind = "image" | "video";
export type SeedProvider = "kie" | "poyo";

/** provider -> kind -> model id -> price. */
export type SeedTable = Record<SeedProvider, Record<SeedKind, Record<string, SeedPrice>>>;

export const EMPTY_SEED: SeedTable = {
  kie:  { image: {}, video: {} },
  poyo: { image: {}, video: {} },
};
