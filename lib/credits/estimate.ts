import { NextResponse } from "next/server";
import { getCreditRates, creditsForUnits, roundCredits } from "@/lib/pricing";
import { getPoyoImageModel } from "@/lib/poyo/imageModels";
import { getMinKieCreditsByModel, getMinCostPerSecByModel } from "@/lib/costs";
import { spendableCredits } from "@/lib/heclus-charge";
import { getFundingModeById } from "@/lib/funding";
import { OPERATOR_POYO } from "@/lib/operators";

// What a run will cost, before it starts.
//
// The wallet's only pre-flight check was "do you have at least one credit",
// which let a balance of 10 authorise five images at 8 credits each and bill 10
// of the 40. The ledger has the partial rows to prove it. This is the estimate
// that check needs: rate for the chosen model, times the number of generations.
//
// Deliberately an estimate and deliberately advisory. The charge still settles
// on what the provider reports, because that is the only figure that is true;
// this exists to refuse a run the balance cannot cover and to say so in credits
// the user recognises. It does not replace reserve-at-submit, which is what
// bounds a race between concurrent submits. It does remove the case that
// actually happens: one person pressing Generate on a run they cannot afford.
//
// Where the per-unit rate comes from, in order of how much it can be trusted:
//
//   PoYo images  – the catalog price, which the provider then confirms or
//                  corrects on the finished task.
//   KIE images   – the cheapest observed cost for that model from
//                  model_cost_and_speed, the same figure the picker prints on
//                  the model card. KIE publishes no per-model price to us.
//   Video        – observed credits per second times the clip duration.
//
// A model with no figure at all returns null rather than zero. A run that
// cannot be priced must not be refused on a made-up number, so the caller
// falls back to the old behaviour of letting it start.

export interface RunEstimate {
  /** Credits for one generation, or null when the model has no known rate. */
  perUnit: number | null;
  /** perUnit times count, rounded the way the ledger rounds. */
  total: number | null;
  /** Spendable now, excluding open reservations. */
  balance: number;
  /** False only when the balance is known to be short. Unknown prices and BYO
   *  accounts both report true: neither is a reason to block work. */
  sufficient: boolean;
  /** What the estimate was built from, for the message and for debugging. */
  source: "poyo-catalog" | "kie-observed" | "video-observed" | "unknown" | "byo";
}

export interface RunEstimateInput {
  userId: string;
  kind: "image" | "video";
  modelId: string;
  /** The operator serving this run. Images only; video is KIE or GenAIPro. */
  operator?: string | null;
  /** How many generations the run will submit. */
  count: number;
  /** Video only: seconds per clip. */
  durationSec?: number | null;
  /** The chosen resolution, when the model prices by one. */
  resolution?: string | null;
}

/**
 * How much a resolution multiplies the base price.
 *
 * GPT Image 2 is the only model that publishes this: 1K is 1x, 2K is 2x, 4K is
 * 4x. The others charge more for more pixels without saying by how much, so the
 * same linear reading is applied to all of them. It is a guess, and it is the
 * guess that fails safely: over-estimating refuses a run slightly early, while
 * under-estimating lets one start that empties the wallet halfway through,
 * which is the failure this whole check exists to prevent.
 */
function resolutionMultiplier(resolution: string | null | undefined): number {
  const match = /^(\d+(?:\.\d+)?)K$/i.exec((resolution ?? "").trim());
  if (!match) return 1;
  const k = Number(match[1]);
  return Number.isFinite(k) && k >= 1 ? k : 1;
}

async function perUnitCredits(
  input: RunEstimateInput,
): Promise<{ perUnit: number | null; source: RunEstimate["source"] }> {
  const rates = await getCreditRates();

  if (input.kind === "video") {
    const perSec = (await getMinCostPerSecByModel("video_gen"))[input.modelId];
    const seconds = Number(input.durationSec ?? 0);
    if (!perSec || !(seconds > 0)) return { perUnit: null, source: "unknown" };
    return {
      perUnit: creditsForUnits("kie_credits", perSec * seconds, rates, { model: input.modelId }),
      source: "video-observed",
    };
  }

  const scale = resolutionMultiplier(input.resolution);

  if (input.operator === OPERATOR_POYO) {
    const model = getPoyoImageModel(input.modelId);
    if (!model) return { perUnit: null, source: "unknown" };
    return {
      perUnit: creditsForUnits("poyo_credits", model.credits * scale, rates, { model: input.modelId, provider: "poyo" }),
      source: "poyo-catalog",
    };
  }

  // The observed figure is the cheapest run of that model, so it already leans
  // low; the resolution scale is what keeps a 4K run from being priced as a 1K
  // one on top of that.
  const observed = (await getMinKieCreditsByModel("image_gen"))[input.modelId];
  if (!observed) return { perUnit: null, source: "unknown" };
  return {
    perUnit: creditsForUnits("kie_credits", observed * scale, rates, { model: input.modelId }),
    source: "kie-observed",
  };
}

export async function estimateRun(input: RunEstimateInput): Promise<RunEstimate> {
  // A BYO account spends its own provider key, so there is nothing here to be
  // short of. Answered before any lookup: the estimate would be meaningless
  // and the balance is not the constraint.
  if ((await getFundingModeById(input.userId)) !== "wallet") {
    return { perUnit: null, total: null, balance: 0, sufficient: true, source: "byo" };
  }

  const [{ perUnit, source }, balance] = await Promise.all([
    perUnitCredits(input),
    spendableCredits(input.userId),
  ]);

  const count = Math.max(1, Math.floor(input.count));
  const total = perUnit === null ? null : roundCredits(perUnit * count);

  return {
    perUnit,
    total,
    balance,
    sufficient: total === null ? true : balance >= total,
    source,
  };
}

/**
 * The response for a run the wallet cannot cover, or null to carry on.
 *
 * Deliberately the same 402 shape requireWalletFunds returns, carrying
 * `outOfCredits`, so the client gate that already watches for it raises the
 * modal with no extra wiring. `needed` is what turns "out of credits" into
 * "not enough for this run", which is a different thing to say to someone who
 * still has credits, just not enough of them.
 */
export function shortfallResponse(estimate: RunEstimate): NextResponse | null {
  if (estimate.sufficient || estimate.total === null) return null;
  const need = estimate.total.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const have = estimate.balance.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return NextResponse.json(
    {
      error: `Not enough Heclus Credits for this run. It needs about ${need} and you have ${have}.`,
      outOfCredits: true,
      credits: estimate.balance,
      needed: estimate.total,
    },
    { status: 402 },
  );
}
