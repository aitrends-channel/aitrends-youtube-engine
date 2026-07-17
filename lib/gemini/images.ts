import { getSettings } from "@/lib/settings";

// Gemini image generation on the USER's own Google AI Studio key (BYO),
// via the free-tier gemini-2.5-flash-image model ("Nano Banana").
// Synchronous like the Cloudflare path — no task id / webhook.
//
// Deliberately NO hardcoded requests/day cap: Google's free-tier limits
// are account- and tier-dependent and Google varies them, so instead of
// tracking an assumed number we surface Google's own rate-limit response
// when the key's real quota is spent.

export class GeminiImageError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "GeminiImageError";
  }
}

const GEMINI_IMAGE_MODELS: Record<string, string> = {
  // Our picker id → AI Studio model path.
  "gemini/flash-image": "gemini-2.5-flash-image",
};

export function isGeminiImageModel(modelId: string): boolean {
  return modelId.startsWith("gemini/");
}

// Aspect ratios gemini-2.5-flash-image accepts via imageConfig.
export const GEMINI_IMAGE_RATIOS = ["16:9", "21:9", "3:2", "4:3", "5:4", "1:1", "4:5", "3:4", "2:3", "9:16"];

/**
 * Generate an image on the user's AI Studio account. Returns
 * { buffer, contentType } ready to upload — same shape as the
 * Cloudflare free path so the routes dispatch interchangeably.
 */
export async function generateGeminiImage(
  prompt: string,
  modelId: string,
  aspectRatio: string,
  userId: string,
): Promise<{ buffer: ArrayBuffer; contentType: string }> {
  const model = GEMINI_IMAGE_MODELS[modelId];
  if (!model) throw new GeminiImageError(`Unknown free image model: ${modelId}`, 400);

  const { gemini_api_key } = await getSettings(userId);
  if (!gemini_api_key) {
    throw new GeminiImageError("Connect your Google AI Studio key in Settings to use free Gemini images.", 401);
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const doFetch = async (): Promise<Response> => {
    try {
      return await fetch(url, {
        method: "POST",
        headers: { "x-goog-api-key": gemini_api_key, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseModalities: ["IMAGE"],
            imageConfig: { aspectRatio: GEMINI_IMAGE_RATIOS.includes(aspectRatio) ? aspectRatio : "1:1" },
          },
        }),
      });
    } catch (err) {
      throw new GeminiImageError(`Google AI Studio network error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // AI Studio's free tier has a low PER-MINUTE rate, and bulk generation
  // fires several beats at once — so first-attempt 429s are normal burst
  // throttling, not an exhausted key. Retry twice with backoff (honoring
  // Retry-After up to 20s) before surfacing the 429 to the user.
  let res = await doFetch();
  for (let attempt = 0; res.status === 429 && attempt < 2; attempt++) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 20_000)
      : 4_000 * (attempt + 1) + Math.random() * 2_000;
    await new Promise((r) => setTimeout(r, waitMs));
    res = await doFetch();
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let googleMsg = "";
    try {
      googleMsg = (JSON.parse(body) as { error?: { message?: string } })?.error?.message ?? "";
    } catch { /* not JSON */ }
    if (res.status === 429) {
      // Quotas are per-key and variable — pass Google's own explanation
      // through instead of guessing at a number.
      throw new GeminiImageError(
        `Your Google AI Studio key hit its rate limit${googleMsg ? ` — ${googleMsg}` : ""}. It resets on Google's schedule, or pick another model.`,
        429,
      );
    }
    if (res.status === 400 && /API key/i.test(googleMsg)) {
      throw new GeminiImageError("Your Google AI Studio key was rejected — check it in Settings.", 401);
    }
    throw new GeminiImageError(
      `Google AI Studio error ${res.status}: ${(googleMsg || body).replace(/\s+/g, " ").trim().slice(0, 300)}`,
      res.status,
    );
  }

  const data = (await res.json().catch(() => null)) as {
    candidates?: { content?: { parts?: { inlineData?: { mimeType?: string; data?: string } }[] } }[];
  } | null;
  const inline = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData;
  if (!inline?.data) {
    throw new GeminiImageError("Google returned no image (the prompt may have been blocked by safety filters).");
  }
  return {
    buffer: Uint8Array.from(Buffer.from(inline.data, "base64")).buffer,
    contentType: inline.mimeType || "image/png",
  };
}
