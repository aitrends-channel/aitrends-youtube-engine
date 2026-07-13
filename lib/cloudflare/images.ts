import { getSettings } from "@/lib/settings";

// Cloudflare Workers AI — free image generation on the USER's own connected
// account (BYO), drawing on their free daily Neuron quota so aiTrends pays
// nothing. Synchronous (no task id / webhook).
//
// Only models covered by the free Neuron allocation are here. Premium
// partner models (FLUX.2 dev/klein) bill per-tile-per-step in USD and are
// deliberately excluded — they'd charge the user's account.
//
// Two response shapes across models: FLUX returns JSON { result: { image:
// "<base64>" } }; Stable Diffusion returns raw image bytes. We branch on
// the response Content-Type so both work through one path.

export class CloudflareError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "CloudflareError";
  }
}

type CfFamily = "flux" | "sdxl";

interface CfModelSpec {
  path: string;      // @cf/... run path
  family: CfFamily;  // drives input shape + supported aspect ratios
}

// Registry keyed by our "cloudflare/…" model id.
const CF_MODELS: Record<string, CfModelSpec> = {
  "cloudflare/flux-1-schnell": { path: "@cf/black-forest-labs/flux-1-schnell", family: "flux" },
  "cloudflare/sdxl-lightning": { path: "@cf/bytedance/stable-diffusion-xl-lightning", family: "sdxl" },
  "cloudflare/sdxl-base":      { path: "@cf/stabilityai/stable-diffusion-xl-base-1.0", family: "sdxl" },
};

export function isCloudflareModel(modelId: string): boolean {
  return modelId.startsWith("cloudflare/");
}

// SDXL accepts width/height (256–2048); map our aspect ratios to pixels.
// FLUX Schnell takes no dimensions (square output), so it ignores this.
const SDXL_DIMS: Record<string, { width: number; height: number }> = {
  "16:9": { width: 1280, height: 720 },
  "1:1":  { width: 1024, height: 1024 },
  "9:16": { width: 720, height: 1280 },
  "4:3":  { width: 1024, height: 768 },
  "3:4":  { width: 768, height: 1024 },
};

// Cloudflare account IDs are 32 hex chars. Users often paste the whole
// dashboard URL into the field, so pull the id out of whatever they saved.
function extractAccountId(raw: string): string | null {
  const m = raw.match(/[0-9a-fA-F]{32}/);
  return m ? m[0] : null;
}

/**
 * Generate an image on the user's Cloudflare Workers AI account using the
 * given free model. Returns { buffer, contentType } ready to upload.
 */
export async function generateCloudflareImage(
  prompt: string,
  modelId: string,
  aspectRatio: string,
  userId: string,
): Promise<{ buffer: ArrayBuffer; contentType: string }> {
  const spec = CF_MODELS[modelId];
  if (!spec) throw new CloudflareError(`Unknown free image model: ${modelId}`, 400);

  const { cloudflare_account_id, cloudflare_api_token } = await getSettings(userId);
  if (!cloudflare_account_id || !cloudflare_api_token) {
    throw new CloudflareError("Connect your Cloudflare account in Settings to use free image generation.", 401);
  }
  const accountId = extractAccountId(cloudflare_account_id);
  if (!accountId) {
    throw new CloudflareError(
      "Your Cloudflare Account ID looks wrong — it should be the 32-character ID from your dashboard URL (dash.cloudflare.com/<Account ID>). Update it in Settings.",
      400,
    );
  }

  // Per-family input. FLUX Schnell: prompt + steps (distilled, 4 is the
  // sweet spot). SDXL: prompt + width/height + num_steps (max 20).
  const input: Record<string, unknown> =
    spec.family === "flux"
      ? { prompt, steps: 4 }
      : { prompt, ...(SDXL_DIMS[aspectRatio] ?? SDXL_DIMS["1:1"]), num_steps: 20 };

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${spec.path}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${cloudflare_api_token}`, "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (err) {
    throw new CloudflareError(`Cloudflare network error: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    if (res.status === 429) {
      throw new CloudflareError("You've hit your Cloudflare free daily image limit. It resets tomorrow, or pick a paid model.", 429);
    }
    throw new CloudflareError(`Cloudflare error ${res.status}: ${body.replace(/\s+/g, " ").trim().slice(0, 300)}`, res.status);
  }

  // FLUX → JSON base64; SDXL → raw image bytes. Branch on Content-Type.
  const contentType = res.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    const data = (await res.json().catch(() => null)) as
      | { result?: { image?: string }; errors?: { message?: string }[] }
      | null;
    const b64 = data?.result?.image;
    if (!b64) throw new CloudflareError(data?.errors?.[0]?.message ?? "Cloudflare returned no image.");
    return { buffer: Uint8Array.from(Buffer.from(b64, "base64")).buffer, contentType: "image/jpeg" };
  }

  // Binary image stream.
  const buffer = await res.arrayBuffer();
  if (!buffer.byteLength) throw new CloudflareError("Cloudflare returned an empty image.");
  return { buffer, contentType: contentType.includes("png") ? "image/png" : "image/jpeg" };
}
