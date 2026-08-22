import Anthropic from "@anthropic-ai/sdk";
import { getActiveProductKey } from "@/lib/claude/routing";

// Claude through PoYo.
//
// PoYo exposes Anthropic's own Messages API rather than an OpenAI-compatible
// shim: POST /v1/messages, x-api-key auth, tools with input_schema, system
// prompts, stream: true. That means the Anthropic SDK drives it directly, the
// way it already drives the KIE relay in lib/claude/client.ts — a base URL
// swap, not a second client.
//
// Contrast with KIE, which needed 461 lines in kieShared.ts to normalise a
// bespoke wire format. This file is short because PoYo did not invent one.
//
// Two differences from Anthropic proper:
//
//   1. Auth. PoYo uses x-api-key, which is Anthropic's native scheme, so the
//      SDK's `apiKey` option works as-is. KIE needed `authToken` because it
//      wanted a bearer token instead.
//   2. Envelope. Their generate endpoints wrap results as { code, data }, and
//      the docs imply /v1/messages does too. Probed against the live API on
//      2026-08-22: it does NOT. /v1/messages returns the raw Anthropic Message,
//      and streaming returns Anthropic's own SSE events unchanged, down to
//      content_block_delta / text_delta. The unwrap below is therefore a
//      pass-through guard for error shapes, not a translation layer.
//
// Pricing: $4/$20 per Mtok against Anthropic's $5/$25, so 20% off list. The
// realised saving is smaller. PoYo reports roughly 800-1000 input tokens of
// overhead on every call regardless of prompt size (7-token prompt, 1040
// reported), and at Heclus's measured median call of ~2.2k input tokens that
// eats most of the input-side discount. Output carries no such overhead, and
// output is two thirds of the bill, so the blended saving lands near 14%
// rather than 20%. Worth having, not worth assuming.

const POYO_BASE_URL = "https://api.poyo.ai";

async function getPoyoKey(): Promise<string> {
  const key = await getActiveProductKey("heclus_poyo_api_key")
    ?? process.env.HECLUS_POYO_API_KEY?.trim()
    ?? null;
  if (!key) {
    throw new Error(
      "Heclus PoYo key not configured — set HECLUS_POYO_API_KEY, or add one in Config → API Keys (service: Heclus PoYo API Key).",
    );
  }
  return key;
}

/**
 * Strips PoYo's { code, data } wrapper so the SDK parses a plain Message.
 *
 * Only touches non-streaming JSON. A streaming response is an SSE byte stream
 * and is passed through untouched: PoYo's docs do not say whether it wraps SSE
 * frames, and rewriting a stream on a guess is how you get a parser that
 * silently yields nothing. If streaming turns out to be wrapped too, this is
 * the one place that changes.
 *
 * Non-200 `code` values are surfaced as the HTTP error the SDK expects rather
 * than handed on as a 200 with an error body, which the SDK would try to parse
 * as a Message and fail on confusingly.
 */
function unwrapEnvelope(): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input as RequestInfo, init as RequestInit);

    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return res;

    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // Not JSON after all. Hand back what we read, unmodified.
      return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
    }

    const env = body as { code?: number; data?: unknown; error?: { message?: string } };

    // Not enveloped (or already an Anthropic-shaped error): pass through.
    if (typeof env?.code !== "number" || env.data === undefined) {
      return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
    }

    if (env.code !== 200) {
      const message = env.error?.message ?? `PoYo error ${env.code}`;
      return new Response(
        JSON.stringify({ type: "error", error: { type: "api_error", message } }),
        { status: res.status === 200 ? 502 : res.status, headers: { "content-type": "application/json" } },
      );
    }

    return new Response(JSON.stringify(env.data), {
      status: 200,
      statusText: res.statusText,
      headers: { "content-type": "application/json" },
    });
  };
}

/** An Anthropic SDK client pointed at PoYo. Same surface as the direct and
 *  KIE-relayed clients, so call sites do not branch. */
export async function makePoyoClaudeClient(): Promise<Anthropic> {
  return new Anthropic({
    apiKey: await getPoyoKey(),
    baseURL: POYO_BASE_URL,
    fetch: unwrapEnvelope(),
    // Same reasoning as the KIE client: retryClaudeCall does backoff at every
    // call site, and SDK-level retries multiply one failure into nine calls.
    maxRetries: 0,
    timeout: 180_000,
  });
}
