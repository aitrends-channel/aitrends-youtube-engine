import type { KieModel } from "@/lib/types";
import type { CostUnitKind } from "@/lib/costs";
import { type Operator, OPERATOR_KIE, OPERATOR_POYO, parseOperator } from "./index";
import { isFreeLaneImageModel } from "./routing";

import { IMAGE_MODELS } from "@/lib/kie/imageModels";
import { submitImageTask, checkImageTask, generateImage } from "@/lib/kie/images";
import { listPoyoImageModels, poyoCreditsFor, getPoyoImageModel } from "@/lib/poyo/imageModels";
import { submitPoyoImageTask, checkPoyoImageTask } from "@/lib/poyo/images";

// One interface over every provider that can generate an image.
//
// The point is not to hide that providers differ. It is to make the difference
// live in one implementation each, so a route can submit a generation without
// knowing whether the answer comes back as KIE's `successFlag` or PoYo's
// `status: "finished"`. Everything genuinely provider-shaped — KIE's three
// different submit endpoints, PoYo's lack of a cost field — stays inside its
// own module.
//
// Deliberately not shared with video. Video submission lives in video-worker,
// a separate repository with its own KIE client, and pulling that across a
// repo boundary is a decision on its own rather than a side effect of adding
// an image provider.

export interface ImageTaskResult {
  status: "pending" | "done" | "failed";
  url?: string;
  error?: string;
  /** Units the provider says it actually charged. Present only for providers
   *  that report it; see `estimate` for the ones that do not. */
  units?: number;
}

export interface ImageSubmit {
  prompt: string;
  modelId: string;
  aspectRatio?: string;
  resolution?: string;
  userId?: string;
  callbackUrl?: string;
}

export interface ImageOperator {
  readonly id: Operator;
  /** The unit this operator's spend is recorded in on project_costs. */
  readonly unitKind: CostUnitKind;
  /** What the picker may offer for this operator. */
  models(): KieModel[];
  submit(req: ImageSubmit): Promise<string>;
  check(req: { taskId: string; modelId?: string; userId?: string }): Promise<ImageTaskResult>;
  /**
   * What one generation is expected to cost, before it runs.
   *
   * Needed because the wallet reserves before submitting. Providers split into
   * two kinds here and the interface has to carry both: KIE reports the true
   * cost on the finished task and its estimate is therefore advisory, while
   * PoYo reports nothing and its estimate IS the charge. Settle with
   * `ImageTaskResult.units` when present and this when not.
   */
  estimate(modelId: string): number | null;
  /**
   * Submit and wait, in one call.
   *
   * Not sugar over submit + check. Thumbnails, the one-click orchestrator and
   * the batch image route all want a URL back from a single request and have
   * no beat row to park a task id on, so they cannot use the async pair at
   * all. Leaving this off the interface is what kept those four call sites
   * hardcoded to KIE when PoYo was added.
   */
  generate(req: ImageSubmit): Promise<{ url: string; units?: number }>;
}

/** Wait for a task the provider has already accepted. Shared by the two
 *  generate() implementations so both inherit the same budget: ~105s, which
 *  fits inside the 120s maxDuration the calling routes declare. */
async function pollToCompletion(
  op: Pick<ImageOperator, "check" | "id">,
  taskId: string,
  modelId: string,
  userId?: string,
): Promise<{ url: string; units?: number }> {
  const POLL_MS = 3000;
  const MAX_ATTEMPTS = 35;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const result = await op.check({ taskId, modelId, userId });
    if (result.status === "done" && result.url) return { url: result.url, units: result.units };
    if (result.status === "failed") throw new Error(result.error ?? "Image generation failed");
  }
  throw new Error("Image generation timed out");
}

const kie: ImageOperator = {
  id: OPERATOR_KIE,
  unitKind: "kie_credits",
  models: () => IMAGE_MODELS,
  submit: ({ prompt, modelId, aspectRatio, resolution, userId, callbackUrl }) =>
    submitImageTask(prompt, modelId, aspectRatio ?? "16:9", resolution, userId, callbackUrl),
  check: async ({ taskId, modelId, userId }) => {
    const r = await checkImageTask(taskId, userId, modelId);
    return { status: r.status, url: r.url, error: r.error, units: r.creditsConsumed };
  },
  // KIE bills per task and tells us what it took on recordInfo, so there is
  // nothing to estimate from. Returning null keeps the caller on the reported
  // figure rather than inventing one that would then disagree with the ledger.
  estimate: () => null,
  generate: async ({ prompt, modelId, aspectRatio, resolution, userId }) => {
    // KIE's own one-shot helper rather than pollToCompletion: it already
    // exists, it handles the three submit endpoint shapes, and routing around
    // it would fork that logic for no gain.
    const r = await generateImage(prompt, modelId, aspectRatio ?? "16:9", resolution, userId);
    return { url: r.url, units: r.creditsConsumed };
  },
};

const poyo: ImageOperator = {
  id: OPERATOR_POYO,
  unitKind: "poyo_credits",
  models: listPoyoImageModels,
  submit: ({ prompt, modelId, aspectRatio, callbackUrl }) =>
    submitPoyoImageTask(prompt, modelId, aspectRatio ?? "16:9", callbackUrl),
  check: ({ taskId }) => checkPoyoImageTask(taskId),
  estimate: (modelId) => poyoCreditsFor(modelId),
  generate: async (req) => {
    const taskId = await submitPoyoImageTask(req.prompt, req.modelId, req.aspectRatio ?? "16:9");
    const done = await pollToCompletion(poyo, taskId, req.modelId, req.userId);
    // PoYo reports no cost, so the catalog price is the charge. Same reasoning
    // as estimate() above.
    return { url: done.url, units: done.units ?? poyoCreditsFor(req.modelId) };
  },
};

const REGISTRY: Record<string, ImageOperator> = { [kie.id]: kie, [poyo.id]: poyo };

/** The operator stamped on a beat. Falls back the way parseOperator does, and
 *  throws only for an operator with no image path at all (genaipro is video). */
export function getImageOperator(value: unknown): ImageOperator {
  const op = REGISTRY[parseOperator(value)];
  if (!op) throw new Error(`No image operator for: ${String(value)}`);
  return op;
}

export type CatalogModel = KieModel & { operator: Operator };

/**
 * Every image model on offer, tagged with who runs it.
 *
 * Both providers carry a model called `z-image`, so an id alone no longer
 * identifies a generation. The pair (id, operator) does, which is what
 * project_beats.image_operator records. Anything choosing a model has to carry
 * the operator with it from here on.
 */
export function listImageCatalog(active: Operator): CatalogModel[] {
  const op = REGISTRY[active] ?? REGISTRY[OPERATOR_KIE];
  return op.models().map((m) => ({ ...m, operator: op.id }));
}

/**
 * Which operator serves this model, for new work.
 *
 * The admin switch decides, not the model id and not the client. `active`
 * comes from getMediaOperatorForUser, which has already applied the per-user
 * and per-surface rules.
 *
 * Two things override it, both because the alternative is billing someone for
 * work that should be free or refusing work that should succeed:
 *
 *   - A free-lane model keeps its own provider whatever the switch says.
 *   - A model the active operator does not carry falls back to whoever does.
 *     That keeps a stale saved model id working rather than failing a
 *     generation at the provider, and it is the case a catalog filtered to the
 *     active operator should already have prevented.
 */
export function resolveImageOperator(modelId: string, active: Operator): ImageOperator {
  if (isFreeLaneImageModel(modelId)) return kie;

  const chosen = REGISTRY[active];
  if (chosen?.models().some((m) => m.id === modelId)) return chosen;

  for (const id of [OPERATOR_KIE, OPERATOR_POYO]) {
    const op = REGISTRY[id];
    if (op?.models().some((m) => m.id === modelId)) return op;
  }
  // Known to nobody. KIE is the historical default and the only operator any
  // stored image_model_id predating the operator column could have used.
  return kie;
}

/** Whether PoYo can serve this model at all, used to gate the picker for BYO
 *  users, who have no PoYo key of their own. See lib/poyo/client.ts. */
export function isPoyoImageModel(modelId: string): boolean {
  return !!getPoyoImageModel(modelId);
}
