import { GENERATED_SEED } from "./seed-prices.generated";
import { MANUAL_SEED } from "./seed-prices.manual";
import type { SeedKind, SeedProvider } from "./seed-types";

/**
 * The seed price for one model at one resolution.
 *
 * `exact` means the figure was recorded against this resolution rather than
 * blended across all of them. An exact figure is used as it stands; a blended
 * one still gets scaled by the resolution ladder, because it is an average of
 * whatever mix has been run and says nothing about this tier on its own.
 *
 * Generated beats manual. Both halves can hold a row for the same model once a
 * previously unrun model gets used, and at that point the measurement is the
 * better number: manual is a published price, generated is what was charged.
 */
export function seedPrice(
  provider: SeedProvider,
  kind: SeedKind,
  modelId: string,
  resolution?: string | null,
): { value: number; exact: boolean } | null {
  for (const table of [GENERATED_SEED, MANUAL_SEED]) {
    const row = table[provider]?.[kind]?.[modelId];
    if (!row) continue;
    if (resolution && row.byResolution) {
      const key = Object.keys(row.byResolution).find(
        (k) => k.toLowerCase() === resolution.toLowerCase(),
      );
      if (key) return { value: row.byResolution[key], exact: true };
    }
    if (typeof row.flat === "number") return { value: row.flat, exact: false };
    // A model with resolutions but not this one: the cheapest listed is a
    // better base to scale than nothing, and matches how a blend is treated.
    const listed = row.byResolution && Object.values(row.byResolution);
    if (listed?.length) return { value: Math.min(...listed), exact: false };
  }
  return null;
}
