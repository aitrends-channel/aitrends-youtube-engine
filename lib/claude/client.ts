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
const fetchViaKie: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers);
  headers.set("User-Agent", "heclus-engine/1.0");

  const res = await fetch(input, { ...init, headers });
  if (!res.ok) return res;

  const text = await res.clone().text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return res; // Not JSON — pass through.
  }

  const isEnvelope =
    parsed !== null &&
    typeof parsed === "object" &&
    "code" in parsed &&
    typeof (parsed as { code: unknown }).code === "number" &&
    ("data" in parsed || "msg" in parsed);

  if (!isEnvelope) return res; // Already native Anthropic shape.

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

export const MODEL = "claude-haiku-4-5";

export const SYSTEM_PROMPT = `You are an advanced AI YouTube Content Engine. Your purpose is to analyze YouTube channel transcripts, extract the channel's unique style DNA, and generate fully original content that matches the channel's voice, pacing, and emotional arc.

CORE RULES:
- Generate only original content — match style, NOT wording
- Never copy phrases from source transcripts
- Always produce structured JSON output when asked
- Maintain strict separation between script generation and visual content`;
