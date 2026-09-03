import Anthropic from "@anthropic-ai/sdk";
import { getSettings } from "@/lib/settings";
import { getRoutingForUser, getActiveProductKey, type WorkflowStep, type AnthropicRouting } from "./routing";
import { getPromptProvider, isKieProvider, kieRoutingFor, supportsProviderChoice, type PromptProvider } from "./providers";
import { fetchKieBalance } from "@/lib/kie/client";
import { KieGptClient } from "./kieGptClient";
import { KieGeminiClient } from "./kieGeminiClient";
import { makePoyoClaudeClient } from "@/lib/poyo/claude";

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

// Builds a per-handle fetchViaKie wrapper that also stashes the
// creditsConsumed value from the upstream response into the given
// ref. Returning a fresh wrapper per Anthropic-client handle keeps
// concurrent calls from clobbering each other's credits.
function makeFetchViaKie(creditsRef: { value: number | null }): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("User-Agent", "heclus-engine/1.0");

    const upstream = await fetch(input, { ...init, headers });

    // Credits-from-headers fallback. KIE doesn't currently expose
    // these on /claude/messages (the streaming endpoint puts credits
    // in the SSE body — see the tee below) but a future endpoint
    // could, and they're cheap to check.
    const headerCredits =
      readNumericHeader(upstream, "x-credits-consumed") ??
      readNumericHeader(upstream, "x-kie-credits-consumed") ??
      readNumericHeader(upstream, "x-kie-credits");
    if (headerCredits != null) creditsRef.value = headerCredits;

    // Streaming (SSE) shortcut — never buffer text/event-stream
    // responses. Reading them with `upstream.text()` waits for the
    // upstream to finish before we hand anything to the SDK, which
    // silently kills real-time streaming (the script route's
    // sendText callbacks fire in a single burst at the end, by which
    // time the browser has long since disconnected). KIE forwards
    // Anthropic's raw SSE bytes on streaming endpoints with the
    // text/event-stream content-type, so there's no envelope to
    // unwrap on this path — pass the response straight through to
    // the SDK while a tee'd branch scans for KIE's credit signal.
    //
    // KIE injects `credits_consumed` into the final `message_delta`
    // event alongside Anthropic's standard usage + delta fields, e.g.
    //   event: message_delta
    //   data: {"usage":{...},"delta":{...},"credits_consumed":26.88,"type":"message_delta"}
    // The SDK ignores the extra field; we just need to lift it into
    // creditsRef so the caller can log it.
    const contentType = (upstream.headers.get("content-type") ?? "").toLowerCase();
    if (upstream.ok && contentType.includes("text/event-stream") && upstream.body) {
      // Do NOT tee() the SSE body. tee() couples the SDK's reader with a
      // second (credit-scan) reader via SHARED BACKPRESSURE: the source is
      // only pulled as fast as the slower branch, and if the fire-and-forget
      // scan branch stalls or errors mid-stream, the source stops pulling
      // and the SDK stops receiving events. On long tool_use generations
      // (image prompts stream a 5-9k-token tool call over ~5 min) that
      // surfaced as a 120s stream stall — the route's idle-abort fired with
      // "Request was aborted" even though KIE was streaming perfectly
      // (verified by calling KIE directly, which has no tee). Instead pipe
      // through a TransformStream so there is exactly ONE consumer (the SDK)
      // and peek at bytes in flight to lift KIE's `credits_consumed` (it
      // lands on the final message_delta). No second reader → no deadlock.
      const decoder = new TextDecoder();
      let creditBuf = "";
      const peekCredits = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk); // pass straight through, unmodified
          try {
            creditBuf += decoder.decode(chunk, { stream: true });
            const m = creditBuf.match(/"credits_consumed"\s*:\s*([0-9]+(?:\.[0-9]+)?)/);
            if (m) creditsRef.value = parseFloat(m[1]);
            // Bound the peek buffer — credits land near end-of-stream, so we
            // only need a recent tail, never the whole 5-9k-token payload.
            if (creditBuf.length > 16384) creditBuf = creditBuf.slice(-4096);
          } catch { /* best-effort peek; never affects the SDK's bytes */ }
        },
      });
      return new Response(upstream.body.pipeThrough(peekCredits), {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
      });
    }

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

    if (!isEnvelope) {
      // Sometimes KIE skips the envelope on success and returns the
      // raw Anthropic shape. Even then, credits can be injected as
      // an extra field — capture if present (snake_case for
      // /claude/messages, camelCase for image/video/tts), then
      // hand the body through.
      const credits =
        readNumericField(parsed, "credits_consumed") ??
        readNumericField(parsed, "creditsConsumed");
      if (credits != null) creditsRef.value = credits;
      return rebuild(upstream, text);
    }

    const env = parsed as { code: number; msg?: string; data?: unknown; creditsConsumed?: unknown; credits_consumed?: unknown };

    // Capture credits from the envelope. KIE uses creditsConsumed
    // on its task-status endpoints (images/video/tts) and
    // credits_consumed on /claude/messages; try both at both the
    // envelope top-level and inside data. Header-derived value
    // (set above) wins only if no envelope field is present.
    const envelopeCredits =
      readNumericField(env, "credits_consumed") ??
      readNumericField(env, "creditsConsumed") ??
      readNumericField(env.data, "credits_consumed") ??
      readNumericField(env.data, "creditsConsumed");
    if (envelopeCredits != null) creditsRef.value = envelopeCredits;

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
}

function readNumericHeader(res: Response, name: string): number | null {
  const raw = res.headers.get(name);
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function readNumericField(obj: unknown, key: string): number | null {
  if (!obj || typeof obj !== "object") return null;
  const v = (obj as Record<string, unknown>)[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// A wrapped Anthropic client that also exposes the active routing
// and a way to read the credits consumed by the most recent call.
// Callers need the routing to decide which cost ledger to write
// (claude_tokens for direct, kie_credits for KIE-mediated), and
// they need the credit count for KIE rows. Direct routes always
// return null for credits — Anthropic doesn't bill us in credits.
export interface AnthropicClientHandle {
  client: Anthropic;
  routing: AnthropicRouting;
  takeLastCreditsConsumed: () => number | null;
  /**
   * Reads the KIE balance this handle is spending, or null when it can't be
   * read — and undefined entirely on direct-to-Anthropic routings, which have
   * no KIE wallet.
   *
   * Callers use it to tell a real empty wallet from an error that merely looks
   * like one: a bare 402 is indistinguishable from "out of credit" by message
   * alone, and abandoning a half-finished run on that reads as broken to a user
   * with a healthy balance. The key stays in this module; callers get a yes/no.
   */
  checkKieBalance?: () => Promise<number | null>;
}

// Build a direct-to-Anthropic client signed with Heclus's company key,
// bypassing KIE entirely. Used (a) as the chosen routing for steps that
// opt in via product_config, and (b) as a manual fallback when a KIE
// call has exhausted its retries — see /api/workflow/visual-analysis.
// Throws if the Heclus Anthropic key isn't configured.
//
// ‼️ This client spends HECLUS's money, so it must never carry a
// user-chosen model. resolveModelForUser already refuses to honour a user
// pick unless the step routes client_kie, which covers routing configured
// up front. What it CANNOT cover is a mid-call switch like (b): the model
// was resolved while the step was still on KIE. If you add a direct
// fallback to a step in USER_CHOICE_STEPS (image/video/thumbnail prompts),
// re-resolve with resolveDefaultModel() before retrying on this client —
// don't reuse the model the KIE attempt was using.
export async function getHeclusDirectClient(): Promise<Anthropic> {
  const anthropicKey = await getActiveProductKey("anthropic_api_key");
  if (!anthropicKey) {
    throw new Error("Heclus Anthropic key not configured — set one in Config → API Keys (service: Anthropic API Key (direct)).");
  }
  return new Anthropic({
    apiKey: anthropicKey,
    maxRetries: 0,
    timeout: 180_000,
  });
}

/** The KIE key a given KIE routing signs with. Shared by the Claude and GPT
 *  paths so "whose key pays" is decided in exactly one place. */
async function resolveKieKey(routing: AnthropicRouting, userId: string): Promise<string> {
  if (routing === "heclus_kie") {
    const key = await getActiveProductKey("heclus_kie_api_key");
    if (!key) {
      throw new Error("Heclus KIE key not configured — set one in Config → API Keys (service: Heclus KIE API Key).");
    }
    return key;
  }
  const key = (await getSettings(userId)).kie_api_key;
  if (!key) throw new Error("KIE API key not configured. Add it in Settings.");
  return key;
}

export interface AnthropicClientOptions {
  /** Pin the model family regardless of the step's configured provider. Used by
   *  call sites that a provider switch would break — e.g. ones that hardcode a
   *  Claude-only model, or send content blocks the GPT facade can't translate. */
  forceProvider?: PromptProvider;
}

export async function getAnthropicClient(
  userId: string,
  step?: WorkflowStep,
  opts?: AnthropicClientOptions,
): Promise<AnthropicClientHandle> {
  const routing = await getRoutingForUser(userId, step);

  // Non-Claude provider path (Config → Anthropic → Per step). Only the prompt
  // steps can opt in, and GPT/Gemini are reachable only through KIE — so a step
  // routed straight to Anthropic falls back to the KIE key of the same payer
  // rather than silently moving who pays. The handle's routing is the KIE one
  // so the cost ledger records credits, not tokens.
  //
  // Both clients are facades (lib/claude/kieGptClient.ts, kieGeminiClient.ts)
  // that mimic the slice of the Anthropic SDK the prompt steps use, which is
  // what lets prompts-core.ts stay provider-agnostic. The cast is the one place
  // that fiction is asserted; keep it narrow by never widening PROVIDER_STEPS
  // to a step whose call sites use SDK surface the facades don't implement.
  const provider = opts?.forceProvider ?? (step ? await getPromptProvider(step) : "claude");

  // The media operator switch outranks the per-step provider choice.
  //
  // Those GPT and Gemini choices are reachable only through KIE's relays, so
  // honouring them while the operator is PoYo or Anthropic would leave most of
  // the workflow on KIE after an admin had explicitly moved it — which is what
  // "writing steps: anthropic" looked like in production, with channel analysis
  // still billing kie_credits on gpt-5-6-sol because that step is configured
  // for GPT. Config → Anthropic → Per step chooses a model; Config → Media
  // Operator chooses a provider, and the provider is the coarser decision.
  //
  // The consequence is deliberate and worth knowing: a step configured for GPT
  // runs Claude while the switch is off KIE, because an Anthropic-format
  // Messages API is the path this client speaks and neither PoYo nor Anthropic
  // serves GPT. Logged rather than silent — "why is my GPT step answering like
  // Claude" is otherwise unanswerable from the outside. Restoring GPT under
  // those operators means another facade beside the KIE one, not removing this.
  const operatorOverridesProvider =
    (routing === "heclus_poyo" || routing === "heclus_direct") && isKieProvider(provider);
  if (operatorOverridesProvider) {
    console.log(
      `[claude] step=${step ?? "-"} configured for ${provider}, but this routing is ${routing} — running Claude instead`,
    );
  }

  if (!operatorOverridesProvider && step && supportsProviderChoice(step) && isKieProvider(provider)) {
    const kieRouting = kieRoutingFor(routing);
    const creditsRef: { value: number | null } = { value: null };
    const kieKey = await resolveKieKey(kieRouting, userId);
    const client = provider === "gemini"
      ? new KieGeminiClient(kieKey, creditsRef)
      : new KieGptClient(kieKey, creditsRef);
    return {
      client: client as unknown as Anthropic,
      routing: kieRouting,
      takeLastCreditsConsumed: () => {
        const v = creditsRef.value;
        creditsRef.value = null;
        return v;
      },
      checkKieBalance: () => fetchKieBalance(kieKey),
    };
  }

  // The client's OWN Anthropic key, native API, bypassing KIE. Only reachable
  // when the step already routes client_kie and the client switched this on
  // (see getRoutingForUser), so this spends the client's money either way —
  // which is why, unlike getHeclusDirectClient, a user-chosen model is fine
  // here. Anthropic bills tokens, so there are no credits to capture.
  if (routing === "client_direct") {
    const apiKey = (await getSettings(userId)).anthropic_api_key;
    if (!apiKey) {
      // getRoutingForUser only returns client_direct when a key is present, so
      // this is a race (key cleared mid-run) rather than a config gap.
      throw new Error("Your Anthropic API key is missing. Re-add it in Setup, or turn off direct Anthropic billing to go back to KIE.");
    }
    return {
      client: new Anthropic({ apiKey, maxRetries: 0, timeout: 180_000 }),
      routing,
      takeLastCreditsConsumed: () => null,
    };
  }

  // Heclus's Anthropic key, native API, bypassing KIE entirely. Useful
  // when KIE is degraded or for high-volume workloads we want billed to
  // Heclus directly. No envelope unwrapping needed — Anthropic returns
  // its native shape, so we don't install fetchViaKie. No credits to
  // capture either — Anthropic bills in tokens via usage on the
  // response, which the caller logs separately.
  if (routing === "heclus_direct") {
    const client = await getHeclusDirectClient();
    return {
      client,
      routing,
      takeLastCreditsConsumed: () => null,
    };
  }

  // Claude through PoYo, on Heclus's PoYo key. Set by the media operator
  // switch (lib/operators/routing.ts), not by the Anthropic routing card.
  //
  // Must sit above the KIE fallthrough. Without this branch heclus_poyo would
  // reach resolveKieKey and be signed with a KIE key against PoYo's base URL,
  // which is the kind of miss a widened union does not fail the build on.
  //
  // Billed per token like the direct paths, so no credits to capture.
  if (routing === "heclus_poyo") {
    return {
      client: await makePoyoClaudeClient(),
      routing,
      takeLastCreditsConsumed: () => null,
    };
  }

  // KIE-mediated paths. The only difference between client_kie and
  // heclus_kie is whose key signs the request.
  const kieKey = await resolveKieKey(routing, userId);

  // Per-handle credits ref — each Anthropic client gets its own
  // fetchViaKie wrapper closed over a private ref, so concurrent
  // workflow calls can't read each other's credits.
  const creditsRef: { value: number | null } = { value: null };

  // KIE expects `Authorization: Bearer <key>`. The SDK's `apiKey` option
  // sends `x-api-key` (Anthropic's native scheme), which KIE rejects with
  // 403. `authToken` swaps the SDK to its bearer-auth path natively. We
  // also explicitly null `apiKey` so a stray ANTHROPIC_API_KEY env var
  // doesn't get picked up and double-send the old header.
  const client = new Anthropic({
    apiKey: null,
    authToken: kieKey,
    baseURL: KIE_CLAUDE_BASE_URL,
    fetch: makeFetchViaKie(creditsRef),
    // Disable the SDK's built-in retries — we have retryClaudeCall on
    // every call site doing its own backoff with logs. Without this,
    // the SDK silently does 1 + 2 retries inside each of our 3 retry
    // attempts, turning one failed chunk into 9 KIE calls and 6+
    // minutes of wasted compute on a transient outage.
    maxRetries: 0,
    // KIE returns 500 at ~45s when it can't fulfill a request, but
    // legitimate Opus calls on large structured outputs (image prompts
    // emitting 50-100 beats, channel analysis on long transcripts) can
    // legitimately take 60-120 seconds. 180s gives those headroom while
    // still failing fast on a hung connection (SDK default is 600s).
    timeout: 180_000,
  });

  return {
    client,
    routing,
    // Take-style accessor so a stale value from a previous call can't
    // get logged a second time — each consumer drains the ref.
    takeLastCreditsConsumed: () => {
      const v = creditsRef.value;
      creditsRef.value = null;
      return v;
    },
    checkKieBalance: () => fetchKieBalance(kieKey),
  };
}

// The default model for the workflow steps is now admin-configurable —
// see lib/claude/models.ts (resolveDefaultModel / getDefaultClaudeModel)
// and Config → Anthropic → Model. The old MODEL and PROMPT_MODEL consts
// lived here; CLAUDE_MODEL_FALLBACK in that module carries the value they
// held, so there's one place to edit when the shipped default moves.

// Fast model for high-volume structured output where Opus's latency
// (and Opus + KIE's intermittent 500 storms) becomes the bottleneck.
// Image-prompts uses this — the route can produce 50-150+ beats per
// run, and Haiku's faster per-token speed combined with the route's
// text-mode fallback (which absorbs Haiku's looser tool_choice
// adherence) wins on overall reliability for that workload.
export const FAST_MODEL = "claude-haiku-4-5";

// The prompt-generation steps (image + video prompts) follow the same
// admin-selected default. They were briefly moved to Haiku to shrink
// per-call latency, but staging showed KIE still returning silent/dead
// streams under Haiku too — the stalls are a KIE-side problem, not model
// latency — so the switch bought nothing and cost quality. Prompt-chunk
// concurrency stays pinned to 1 (see CONCURRENCY_DEFAULTS) to avoid KIE
// queueing under Opus's longer calls; revisit that if the default is ever
// set to a faster model and KIE stabilizes.

// Vision analysis runs on Opus 4.7 (per user request). We previously
// ran Haiku here because Opus + ~10 image blocks could exceed the
// old function-timeout caps and surface as "network error". With the
// 800s Pro ceiling that risk is much smaller, but it's still real on
// extended outages or KIE blips. The route already has a defensive
// parser + mode-aware prompt as safety nets, so the model swap is
// the only thing that changes here.
export const VISION_MODEL = "claude-opus-4-7";

export const SYSTEM_PROMPT = `You are an advanced AI YouTube Content Engine. Your purpose is to analyze YouTube channel transcripts, extract the channel's unique style DNA, and generate fully original content that matches the channel's voice, pacing, and emotional arc.

CORE RULES:
- Generate only original content — match style, NOT wording
- Never copy phrases from source transcripts
- Always produce structured JSON output when asked
- Maintain strict separation between script generation and visual content`;
