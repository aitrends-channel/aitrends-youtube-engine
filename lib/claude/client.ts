import Anthropic from "@anthropic-ai/sdk";
import { getSettings } from "@/lib/settings";

const KIE_CLAUDE_BASE_URL = "https://api.kie.ai/claude";

// Per-request fetch wrapper. Handles three KIE quirks:
//
//   (1) UA block — KIE returns HTTP 403 "Your request was blocked." for
//       any request whose User-Agent matches the Anthropic SDK's default
//       ("Anthropic/JS X.Y.Z"). We overwrite the UA to a neutral string.
//
//   (2) Envelope on failure — KIE wraps its own failures (e.g. insufficient
//       credits) in HTTP 200 with body `{ code: <4xx>, msg, data: null }`.
//       We rewrite that into a proper HTTP error with Anthropic's error
//       shape so the SDK throws and our route catch-blocks get a real
//       message instead of crashing later on undefined fields.
//
//   (3) Envelope on success — KIE also wraps successful upstream Anthropic
//       responses in `{ code: <2xx>, msg, data: { <actual response> } }`.
//       The SDK would parse that as the top-level message and find no
//       `content`. We unwrap to the native Anthropic shape before handing
//       the response back.
// Build a fresh Response from a body string while preserving the
// upstream status/headers. We never hand `res` itself back to the SDK
// because reading the body for envelope-detection consumes the stream;
// even .clone() is flaky on large responses under undici (Next.js).
//
// Headers about the wire encoding of the original body (content-encoding,
// content-length, transfer-encoding) are dropped — undici has already
// decompressed when we did `.text()`, so forwarding e.g. `gzip` would
// tell the SDK's reader to decompress an already-plain string and
// silently fail.
function rebuild(upstream: Response, body: string): Response {
  const headers = new Headers();
  upstream.headers.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (lower === "content-encoding" || lower === "content-length" || lower === "transfer-encoding") return;
    headers.set(name, value);
  });
  headers.set("content-type", upstream.headers.get("content-type") ?? "application/json");
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

const fetchViaKie: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("User-Agent", "heclus-engine/1.0");

  const upstream = await fetch(input, { ...init, headers });
  // Consume the body exactly once.
  const text = await upstream.text();

  if (!upstream.ok) return rebuild(upstream, text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return rebuild(upstream, text); // Not JSON — pass through.
  }

  const isEnvelope =
    parsed !== null &&
    typeof parsed === "object" &&
    "code" in parsed &&
    typeof (parsed as { code: unknown }).code === "number" &&
    ("data" in parsed || "msg" in parsed);

  if (!isEnvelope) return rebuild(upstream, text); // Already native Anthropic shape.

  const env = parsed as { code: number; msg?: string; data?: unknown };

  if (env.code >= 400) {
    const message = env.msg || `KIE error ${env.code}`;
    // The Anthropic SDK formats error messages as `${status} ${error.message}`
    // — it reads from the *top-level* `message` field, not the nested
    // `error.error.message`. Set both so the SDK surfaces a clean message
    // and consumers checking the nested shape still find it.
    const body = JSON.stringify({
      type: "error",
      message,
      error: { type: "api_error", message },
    });
    // NOTE: statusText must be ASCII — Node's Response constructor throws
    // on non-ASCII (KIE's "Credits insufficient" message contains a curly
    // apostrophe). The real message stays in the body for the SDK to surface.
    return new Response(body, {
      status: env.code,
      statusText: "KIE error",
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify(env.data ?? {}), {
    status: 200,
    statusText: "OK",
    headers: { "content-type": "application/json" },
  });
};

export async function getAnthropicClient(userId: string): Promise<Anthropic> {
  const { kie_api_key } = await getSettings(userId);
  if (!kie_api_key) throw new Error("KIE API key not configured. Add it in Settings.");
  // KIE expects `Authorization: Bearer <key>`. The SDK's `apiKey` option
  // sends `x-api-key` (Anthropic's native scheme), which KIE rejects with
  // 403. `authToken` swaps the SDK to its bearer-auth path natively. We
  // also explicitly null `apiKey` so a stray ANTHROPIC_API_KEY env var
  // doesn't get picked up and double-send the old header.
  return new Anthropic({
    apiKey: null,
    authToken: kie_api_key,
    baseURL: KIE_CLAUDE_BASE_URL,
    fetch: fetchViaKie,
  });
}

export const MODEL = "claude-opus-4-7";

// Vision analysis runs on Opus 4.7 now that we're on Vercel Pro (800s
// per-function ceiling). Earlier we forced Haiku here because Opus +
// 10 image blocks blew past the old 60s/120s/300s caps and surfaced as
// "Connection error" from the SDK. Opus produces tighter structured
// output and the wrapper/flat-shape quirk that Haiku has should
// disappear with this model. The defensive parser in the route stays
// as a safety net.
export const VISION_MODEL = "claude-opus-4-7";

export const SYSTEM_PROMPT = `You are an advanced AI YouTube Content Engine. Your purpose is to analyze YouTube channel transcripts, extract the channel's unique style DNA, and generate fully original content that matches the channel's voice, pacing, and emotional arc.

CORE RULES:
- Generate only original content — match style, NOT wording
- Never copy phrases from source transcripts
- Always produce structured JSON output when asked
- Maintain strict separation between script generation and visual content`;
