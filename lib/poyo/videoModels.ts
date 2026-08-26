// Which KIE video models PoYo can also serve.
//
// A copy of video-worker/src/lib/poyoVideoModels.ts, which owns the submit side
// of this. The engine needs it to answer a different question: what to grey out
// in the picker when PoYo is the active operator. Duplicated rather than shared
// because the two repositories deploy separately and have no package between
// them yet; that gap is the "two repositories, one provider" item in the wallet
// document, and this is one more reason to close it.
//
// The 2026-08-24 probe concluded PoYo carried no Veo, Sora, Runway or Kling 3,
// and it was wrong. It sent KIE's identifiers, and "Model not found" is equally
// what a real model under a different name returns. Re-probed 2026-08-26 against
// the names PoYo advertises: sora-2-official, veo3.1-fast, veo3.1-quality and
// runway-gen-4.5 all exist.
//
// Those four are version substitutions, not equivalences. KIE sells Veo 3 and
// Runway Gen-4; PoYo carries Veo 3.1 and Gen-4.5. A clip served by PoYo is the
// newer model under the older model's label in the picker, which is a known and
// accepted inaccuracy rather than an oversight.
//
// Still absent, after roughly sixty spellings: plain Kling 3.0, where only the
// motion-control variant exists and that is a different product needing a motion
// reference, and every Wan id. Those keep the picker's gate.

/** KIE model id -> PoYo model id. Only verified pairs belong here. */
export const KIE_TO_POYO_VIDEO: Record<string, string> = {
  "bytedance/seedance-2": "seedance-2",
  "bytedance/seedance-2-fast": "seedance-2-fast",
  "bytedance/seedance-1.5-pro": "seedance-1.5-pro",
  "kling-2.6/image-to-video": "kling-2.6",
  "grok-imagine/image-to-video": "grok-imagine",
  "hailuo/02-image-to-video-pro": "hailuo-02",
  "sora-2-image-to-video": "sora-2-official",
  "veo3": "veo3.1-quality",
  "veo3_fast": "veo3.1-fast",
  "runway": "runway-gen-4.5",
};

export function poyoVideoModelFor(kieModelId: string): string | null {
  return KIE_TO_POYO_VIDEO[kieModelId] ?? null;
}

/**
 * The resolutions PoYo accepts, by its own model id.
 *
 * A copy of POYO_VIDEO_LIMITS in video-worker/src/lib/poyoVideoModels.ts, which
 * owns the clamping at submit. Needed here because PoYo and KIE do not accept
 * the same sets for the same model, and the picker was rendering KIE's list
 * whichever operator was serving. Three consequences, all real: Seedance 2 Fast
 * accepts 1080p and 4k on PoYo and the picker offered only 480p and 720p;
 * Hailuo 02 accepts 512P and 768P and the picker offered nothing; and Grok
 * Imagine has no resolution knob on PoYo while the picker offered KIE's two,
 * so the choice was silently dropped at submit.
 *
 * An absent entry means the model has no resolution choice on PoYo, which is
 * different from an unmapped model. Both read as "offer nothing", which is
 * correct: PoYo picks its own default.
 */
const POYO_VIDEO_RESOLUTIONS: Record<string, string[]> = {
  "seedance-2": ["480p", "720p", "1080p", "4k"],
  "seedance-2-fast": ["480p", "720p", "1080p", "4k"],
  "seedance-1.5-pro": ["480p", "720p", "1080p"],
  "hailuo-02": ["512P", "768P"],
  "veo3.1-fast": ["720p", "1080p", "4k"],
  "veo3.1-quality": ["720p", "1080p", "4k"],
  // kling-2.6, grok-imagine, sora-2-official and runway-gen-4.5 take a duration
  // and nothing else. Confirmed rather than assumed: the last two accept a
  // resolution field and ignore it, which is worse than rejecting it.
};

/** The resolutions to offer for a KIE model id when PoYo is serving it, or
 *  undefined when PoYo does not carry the model at all. An empty array means
 *  PoYo carries it with no resolution choice. */
export function poyoVideoResolutions(kieModelId: string): string[] | undefined {
  const poyoId = poyoVideoModelFor(kieModelId);
  if (!poyoId) return undefined;
  return POYO_VIDEO_RESOLUTIONS[poyoId] ?? [];
}

/**
 * Models PoYo carries that KIE does not, by their PoYo id.
 *
 * Nothing in the picker offers these yet, so today this list changes nothing
 * on screen. It exists so the gate is symmetric: the first time a PoYo-only
 * model is added to the catalog, it is greyed out under KIE rather than
 * offered and failed at submit, which is exactly how the Veo-under-PoYo
 * problem started.
 */
export const POYO_ONLY_VIDEO = [
  "seedance-2.5", "seedance-2-mini", "hailuo-2.3", "hailuo-03",
  "kling-2.5-turbo-pro", "kling-3.0-motion-control", "veo3.1-fast-official",
];

export function isPoyoOnlyVideo(modelId: string): boolean {
  return POYO_ONLY_VIDEO.includes(modelId);
}
