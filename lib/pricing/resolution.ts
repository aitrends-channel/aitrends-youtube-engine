// How much a resolution multiplies a generation's price.
//
// Only needed while the ledger has no per-resolution history for a model. Once
// model_cost_and_speed carries a row for (model, resolution) the estimate reads
// that instead and this file stops being consulted for it, which is the point:
// a measured figure beats a table of assumptions, and every row here is an
// assumption.
//
// Two things the previous version of this got wrong, both worth naming because
// the numbers below are shaped around them.
//
// First, it was applied to the wrong base. The observed figure the multiplier
// scaled is the MINIMUM ever recorded for that model, blended across
// resolutions, so it most plausibly came from the cheapest resolution the model
// offers. Multiplying it by the absolute factor for 4K double-counts whatever
// the base already included. seedream-4.5 shows it plainly: it offers 2K and 4K
// and nothing smaller, so its cheapest observation is a 2K one, and pricing 4K
// at 4x the base charged twice for a step already in the number. The multiplier
// has to be relative to the model's own cheapest offered resolution, not to an
// imaginary 1K.
//
// Second, video was left out entirely. The estimate passed a resolution in and
// the video branch never read it, so every clip was priced at whatever the
// cheapest resolution had cost.
//
// Direction of error: over-estimating refuses a run slightly early and releases
// the difference the moment the work settles. Under-estimating is permanent,
// because credits_settle caps a settle at the hold and Heclus absorbs the
// overrun. So where these numbers are uncertain they lean high.

/**
 * Relative cost weight of a resolution label. The scale has no unit; only
 * ratios between two labels are meaningful.
 *
 * Images: 1K / 2K / 4K are the published GPT Image 2 curve (1x, 2x, 4x), and
 * the other image models charge more for more pixels without saying by how
 * much, so they are read the same way. Parsed rather than listed so 3K, and
 * anything else PoYo adds, lands in the right place without an edit here.
 *
 * Video: not pixel area. Pixel count would make 4K nine times a 480p clip,
 * which no vendor charges. These follow the published steps where we have them
 * (Veo's 4K "bills at roughly double a Fast-mode clip") and interpolate
 * between where we do not.
 */
const VIDEO_WEIGHTS: Record<string, number> = {
  "360p": 0.45,
  "480p": 0.6,
  "512p": 0.6,
  "540p": 0.75,
  "576p": 0.8,
  "720p": 1,
  "768p": 1.1,
  "1080p": 1.8,
  "1440p": 2.6,
  "2k": 2.6,
  "4k": 3.5,
  // Kling 3.0 prices by a "mode" enum rather than a resolution. Its three
  // modes are 720p / 1080p / 4K under the hood, so they weigh the same.
  std: 1,
  pro: 1.8,
};

/** The image ladder: "1K" is 1, "2K" is 2, "4K" is 4. */
function imageWeight(label: string): number | null {
  const match = /^(\d+(?:\.\d+)?)k$/.exec(label);
  if (!match) return null;
  const k = Number(match[1]);
  return Number.isFinite(k) && k > 0 ? k : null;
}

/**
 * The weight of one label, or null when the label says nothing about price.
 *
 * A null is not an error. Aspect ratios ("16:9"), PoYo's pixel sizes
 * ("1024x1536") and the models with no resolution knob at all all land here,
 * and the caller treats an unknown label as "no scaling" rather than guessing.
 */
export function resolutionWeight(
  kind: "image" | "video",
  resolution: string | null | undefined,
): number | null {
  const label = (resolution ?? "").trim().toLowerCase();
  if (!label) return null;
  // 4K is on both ladders and means the same thing on each, so the video table
  // is consulted first for video and the K parse only backs it up.
  if (kind === "video") return VIDEO_WEIGHTS[label] ?? imageWeight(label);
  return imageWeight(label);
}

/**
 * What to multiply a blended observed price by, to price `resolution`.
 *
 * `offered` is every resolution the model exposes, from the same config the
 * picker renders. The cheapest of them is treated as the resolution the blended
 * observation came from, since that observation is a minimum.
 *
 * Returns 1 whenever the question cannot be answered: an unrecognised label, a
 * model with no resolution knob, or one whose offered list we cannot weigh. In
 * each of those cases the honest answer is to leave the estimate alone.
 */
export function relativeResolutionMultiplier(
  kind: "image" | "video",
  resolution: string | null | undefined,
  offered: string[] | undefined,
): number {
  const chosen = resolutionWeight(kind, resolution);
  if (chosen === null) return 1;

  // A resolution this model does not offer. Happens on the cheaper-alternative
  // suggestion, which prices other models against the resolution chosen for the
  // one that did not fit: without this, a 4K choice would scale a model that
  // tops out at 720p by 4K's factor and hide a suggestion the user could
  // actually take. Switching models resets the picker to that model's first
  // resolution, so the honest price is its base.
  const label = (resolution ?? "").trim().toLowerCase();
  const offers = (offered ?? []).map((r) => r.trim().toLowerCase());
  if (offers.length > 0 && !offers.includes(label)) return 1;

  const weights = offers
    .map((r) => resolutionWeight(kind, r))
    .filter((w): w is number => w !== null);
  // No offered list to compare against. Fall back to the absolute weight,
  // which is the old behaviour and still better than ignoring resolution.
  if (weights.length === 0) return chosen;

  const cheapest = Math.min(...weights);
  if (!(cheapest > 0)) return chosen;
  // Never below 1: the base is a minimum, so scaling it down would price a run
  // under the cheapest thing we have ever actually paid for this model.
  return Math.max(1, chosen / cheapest);
}
