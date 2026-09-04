import { OPERATOR_POYO } from "@/lib/operators";
import { poyoImageConfig } from "@/lib/poyo/imageModels";
import { getModelConfig } from "@/lib/kie/imageModels";
import { getVideoModelConfig } from "@/lib/kie/videoModels";
import { sortResolutions } from "@/lib/pricing/resolution";

// The resolution a run will actually use, decided where the money is decided.
//
// The client sends one only when its picker has settled on one, and a request
// that arrives without it still generates: the provider applies its own
// default, which is the lowest the model offers. Everything downstream then
// prices a run whose resolution it does not know. The estimate falls back to
// the blend across every resolution, the hold pads that guess by a quarter, and
// the cost row is written with a null resolution, so tomorrow's snapshot cannot
// learn the price either.
//
// That is how a gpt-image-2 image listed at 2 credits, and settled at 2, came
// to hold 2.50 against a customer's balance for the length of the run.
//
// Same rule the picker uses: the lowest the model offers, never the vendor's
// first, which is 4K on several models.

function pick(list: string[] | undefined, kind: "image" | "video", requested?: string | null): string | undefined {
  if (!list?.length) return undefined;
  const asked = (requested ?? "").trim();
  if (asked) {
    const match = list.find((r) => r.toLowerCase() === asked.toLowerCase());
    if (match) return match;
  }
  return sortResolutions(kind, list)[0];
}

/** Undefined when the model has no resolution control, which is not the same
 *  as "unknown": those models have one price, so the estimate is exact already. */
export function effectiveImageResolution(
  modelId: string, operator: string | null | undefined, requested?: string | null,
): string | undefined {
  const config = operator === OPERATOR_POYO ? poyoImageConfig(modelId) : getModelConfig(modelId);
  return pick(config.resolutions, "image", requested);
}

export function effectiveVideoResolution(
  modelId: string, operator: string | null | undefined, requested?: string | null,
): string | undefined {
  return pick(getVideoModelConfig(modelId, operator).resolutions, "video", requested);
}
