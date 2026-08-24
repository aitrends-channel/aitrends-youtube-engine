// Which KIE video models PoYo can also serve.
//
// A copy of video-worker/src/lib/poyoVideoModels.ts, which owns the submit side
// of this. The engine needs it to answer a different question: what to grey out
// in the picker when PoYo is the active operator. Duplicated rather than shared
// because the two repositories deploy separately and have no package between
// them yet; that gap is the "two repositories, one provider" item in the wallet
// document, and this is one more reason to close it.
//
// Probed directly on 2026-08-24: runway, runway-gen4, veo3, veo-3, kling-3,
// kling-3.0 and sora-2 all return "Model not found". PoYo does not carry them
// for video, which is why those stay on KIE rather than being a mapping nobody
// has written yet.

/** KIE model id -> PoYo model id. Only verified pairs belong here. */
export const KIE_TO_POYO_VIDEO: Record<string, string> = {
  "bytedance/seedance-2": "seedance-2",
  "bytedance/seedance-2-fast": "seedance-2-fast",
  "bytedance/seedance-1.5-pro": "seedance-1.5-pro",
  "kling-2.6/image-to-video": "kling-2.6",
  "grok-imagine/image-to-video": "grok-imagine",
  "hailuo/02-image-to-video-pro": "hailuo-02",
};

export function poyoVideoModelFor(kieModelId: string): string | null {
  return KIE_TO_POYO_VIDEO[kieModelId] ?? null;
}
