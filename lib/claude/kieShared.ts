/**
 * Shared machinery for the KIE provider facades.
 *
 * lib/workflow/prompts-core.ts is built on the Anthropic SDK — messages.stream,
 * tool_use blocks, input_json_delta beat tallying, idle-abort, keepalives, the
 * <tool_calls> text fallback. Rather than fork ~1,900 lines of that per
 * provider, each facade speaks that same surface and translates underneath.
 * Everything that doesn't depend on the upstream wire format lives here; the
 * per-provider modules (kieGptClient, kieGeminiClient) supply only a URL, a
 * request body, and an SSE event reader.
 *
 * The two relays are genuinely different shapes — GPT is the Responses API
 * (`input`, `text.format`, `response.output_text.delta`), Gemini is
 * chat/completions (`messages`, `response_format`, `choices[].delta.content`) —
 * which is why the split is "shared core + thin dialect" rather than one client
 * with a flag.
 */

export type CacheControl = { type: string } | undefined;

export interface TextBlockParam {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

export interface MessageParam {
  role: "user" | "assistant";
  content: string | Array<TextBlockParam | { type: string; [k: string]: unknown }>;
}

export interface ToolParam {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface KieCreateParams {
  model: string;
  max_tokens?: number;
  system?: string | TextBlockParam[];
  messages: MessageParam[];
  tools?: ToolParam[];
  tool_choice?: unknown;
  /** Accepted and ignored — a Claude-only knob modelParamsFor may spread in. */
  thinking?: unknown;
}

export interface KieRequestOptions {
  signal?: AbortSignal;
}

export type ContentBlock =
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "text"; text: string };

export interface KieMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: ContentBlock[];
  stop_reason: string | null;
  stop_sequence: null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
}

/** Only the event shapes prompts-core branches on. Everything else it treats as
 *  activity and uses purely to reset the idle timer. */
export type KieStreamEvent =
  | { type: "content_block_delta"; index: number; delta: { type: "input_json_delta"; partial_json: string } }
  | { type: "ping" };

/** Error carrying an HTTP-ish status so retryClaudeCall (lib/claude/retry.ts)
 *  can tell a transient 5xx from a permanent 4xx. */
export class KieError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "KieError";
    this.status = status;
  }
}

/**
 * OpenAI-style strict json_schema requires additionalProperties:false on every
 * object and every property listed in `required`. Our hand-written schemas
 * (lib/claude/anthropicSchemas.ts) already list every property as required but
 * omit additionalProperties, so this adds it recursively rather than asking
 * every schema author to remember. Returns a copy — the source schemas are
 * shared with the Claude path and must not be mutated.
 */
export function strictify(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(strictify);
  if (!schema || typeof schema !== "object") return schema;

  const node = { ...(schema as Record<string, unknown>) };

  if (node.properties && typeof node.properties === "object") {
    const props = node.properties as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) next[k] = strictify(v);
    node.properties = next;
    node.additionalProperties = false;
    // Strict mode has no concept of an optional property: anything not in
    // `required` is rejected outright, so every key has to be listed.
    node.required = Object.keys(next);
  }
  if (node.items) node.items = strictify(node.items);

  return node;
}

/** Flattens Anthropic's system field (string or text blocks) into one string.
 *  cache_control is dropped — neither relay has a prompt-cache equivalent. */
export function flattenSystem(system: KieCreateParams["system"], fallback: string): string {
  if (!system) return fallback;
  if (typeof system === "string") return system.trim() || fallback;
  const joined = system
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
  return joined || fallback;
}

/**
 * Flattens one message's content to plain text segments.
 *
 * Throws on any non-text block rather than dropping it. Silently discarding an
 * image block would send a vision prompt with no image and get back confident
 * nonsense — far worse than a loud failure. If a provider-eligible step ever
 * needs images, map them in the caller's body builder instead of relaxing this.
 */
export function flattenContent(content: MessageParam["content"], provider: string): string[] {
  if (typeof content === "string") return [content];
  return content.map((b) => {
    if (b.type === "text") return (b as TextBlockParam).text;
    throw new KieError(
      `KIE ${provider} client: unsupported content block "${b.type}". Only text blocks are translated; ` +
      `route this call to Claude (getAnthropicClient's forceProvider option) or add a mapping.`,
      400,
    );
  });
}

/** KIE wraps its own failures as HTTP 200 `{ code: 4xx/5xx, msg, data: null }`.
 *  Detect that and surface it as a real error with the inner status. */
export function throwIfEnvelopeError(parsed: unknown, fallbackStatus: number): void {
  if (parsed && typeof parsed === "object") {
    const env = parsed as { code?: unknown; msg?: unknown };
    if (typeof env.code === "number" && env.code >= 400) {
      throw new KieError(typeof env.msg === "string" ? env.msg : `KIE error ${env.code}`, env.code);
    }
  }
  if (fallbackStatus >= 400) throw new KieError(`KIE error ${fallbackStatus}`, fallbackStatus);
}

export interface UsageLike {
  input_tokens?: number;
  output_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

export function readUsage(usage: UsageLike | null | undefined): KieMessage["usage"] {
  const u = usage ?? {};
  return {
    // Responses uses input/output_tokens; chat/completions uses prompt/completion_tokens.
    input_tokens: u.input_tokens ?? u.prompt_tokens ?? 0,
    output_tokens: u.output_tokens ?? u.completion_tokens ?? 0,
    cache_read_input_tokens: u.input_tokens_details?.cached_tokens ?? 0,
    cache_creation_input_tokens: 0,
  };
}

/**
 * Strips a markdown code fence around a JSON payload.
 *
 * Both relays are asked for strict json_schema output, and both mostly comply —
 * but Gemini (3-flash especially) still wraps the object in ```json … ```
 * a good share of the time. Left alone that parses as nothing and the whole
 * chunk is thrown away and retried, so unwrap before parsing. Only touches
 * text that actually starts with a fence; anything else is returned untouched.
 */
export function unfence(raw: string): string {
  const t = raw.trim();
  if (!t.startsWith("```")) return raw;
  return t.replace(/^```(?:[a-zA-Z0-9_-]+)?\s*\n?/, "").replace(/\n?\s*```$/, "");
}

/**
 * Turns accumulated JSON text into the message prompts-core expects.
 *
 * On success that's a synthetic tool_use block, so the tool_use branch at every
 * call site works untouched. On a parse failure we deliberately return a TEXT
 * block instead: prompts-core already falls back to extractToolInputFromText
 * for exactly this case on the Claude path, so a malformed response lands in a
 * recovery path that already exists rather than a new one.
 */
export function toMessage(
  params: KieCreateParams,
  raw: string,
  meta: { id?: string; truncated?: boolean; usage?: UsageLike | null },
): KieMessage {
  const id = meta.id ?? `kie_${Date.now()}`;
  const toolName = params.tools?.[0]?.name;

  let content: ContentBlock[];
  if (toolName) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(unfence(raw));
    } catch {
      /* fall through to the text block below */
    }
    content = parsed
      ? [{ type: "tool_use", id: `toolu_${id}`, name: toolName, input: parsed }]
      : [{ type: "text", text: raw }];
  } else {
    content = [{ type: "text", text: raw }];
  }

  return {
    id,
    type: "message",
    role: "assistant",
    model: params.model,
    content,
    // Neither relay currently enforces an output ceiling, but map a reported
    // truncation anyway so the existing split-and-retry recovery would engage.
    stop_reason: meta.truncated ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: readUsage(meta.usage),
  };
}

/** What a dialect's event reader returns for one parsed SSE payload. */
export interface ParsedEvent {
  /** Incremental output text, if this event carried any. */
  delta?: string;
  /** Terminal metadata, when this event ends the response. */
  final?: { id?: string; truncated?: boolean; usage?: UsageLike | null };
  /** Credits KIE reports for the call. */
  credits?: number;
  /** Upstream reported a failure. */
  error?: string;
}

export interface KieStreamConfig {
  url: string;
  apiKey: string;
  body: unknown;
  params: KieCreateParams;
  creditsRef: { value: number | null };
  signal?: AbortSignal;
  /** Provider name, used only in error messages. */
  provider: string;
  /** Translates one parsed SSE data payload into the shared shape. */
  parseEvent: (evt: Record<string, unknown>) => ParsedEvent;
}

/**
 * Streaming handle shared by both facades. Async-iterable of Anthropic-shaped
 * events, plus finalMessage(). The request starts on first iteration (or on
 * finalMessage() if the caller never iterates), matching the SDK's behaviour.
 */
export class KieStream {
  private started = false;
  private settled = false;
  private final: KieMessage | null = null;
  private failure: unknown = null;
  private waiters: Array<() => void> = [];

  constructor(private readonly cfg: KieStreamConfig) {}

  private settle(): void {
    this.settled = true;
    for (const w of this.waiters) w();
    this.waiters = [];
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<KieStreamEvent> {
    this.started = true;
    const { url, apiKey, body, params, creditsRef, signal, provider, parseEvent } = this.cfg;

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
          "User-Agent": "heclus-engine/1.0",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      this.failure = err;
      this.settle();
      throw err;
    }

    // A KIE-level failure comes back as JSON, not SSE — surface it as an error
    // rather than letting the SSE parser find nothing and report an empty turn.
    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!res.ok || !contentType.includes("text/event-stream")) {
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* not JSON */
      }
      let err: unknown;
      try {
        throwIfEnvelopeError(parsed, res.status);
        err = new KieError(`KIE ${provider} returned ${contentType || "no content-type"}`, res.status || 500);
      } catch (e) {
        err = e;
      }
      this.failure = err;
      this.settle();
      throw err;
    }

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let accum = "";
    let meta: { id?: string; truncated?: boolean; usage?: UsageLike | null } = {};

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE frames are separated by a blank line. Keep the trailing partial.
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";

        for (const frame of frames) {
          const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          const payload = dataLine.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(payload) as Record<string, unknown>;
          } catch {
            continue;
          }

          const parsedEvent = parseEvent(evt);
          if (typeof parsedEvent.credits === "number") creditsRef.value = parsedEvent.credits;
          if (parsedEvent.error) throw new KieError(parsedEvent.error, 500);
          if (parsedEvent.final) meta = { ...meta, ...parsedEvent.final };

          if (parsedEvent.delta) {
            accum += parsedEvent.delta;
            // The model's text IS the tool input here, so it maps onto
            // input_json_delta — which is what the beat tally counts.
            yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: parsedEvent.delta } };
          } else {
            // Any other event still counts as activity — prompts-core resets
            // its idle timer on every yielded event.
            yield { type: "ping" };
          }
        }
      }
      this.final = toMessage(params, accum, meta);
    } catch (err) {
      this.failure = err;
      throw err;
    } finally {
      // Covers the early-break path (cancellation): drop the connection rather
      // than leaving it draining in the background.
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
      this.settle();
    }
  }

  async finalMessage(): Promise<KieMessage> {
    if (this.final) return this.final;
    if (this.failure) throw this.failure;

    if (!this.started) {
      for await (const _ of this) void _;
    } else if (!this.settled) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }

    if (this.failure) throw this.failure;
    if (!this.final) {
      // Reached when the consumer broke out of the loop early (cancellation).
      throw new KieError(`KIE ${this.cfg.provider} stream ended without a final message`, 500);
    }
    return this.final;
  }
}

/** Shared non-streaming POST: sends the body, unwraps KIE's envelope, captures
 *  credits, and hands the raw payload back for the dialect to read. */
export async function kiePost(
  url: string,
  apiKey: string,
  body: unknown,
  creditsRef: { value: number | null },
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "User-Agent": "heclus-engine/1.0",
    },
    body: JSON.stringify(body),
    signal,
  });

  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new KieError(`KIE returned non-JSON (${res.status})`, res.status || 500);
  }

  throwIfEnvelopeError(parsed, res.status);

  const payload = parsed as Record<string, unknown>;
  const credits = payload.credits_consumed;
  if (typeof credits === "number") creditsRef.value = credits;
  return payload;
}
