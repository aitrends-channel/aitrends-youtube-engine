/**
 * An Anthropic-shaped facade over KIE's GPT relay.
 *
 * lib/workflow/prompts-core.ts is built on the Anthropic SDK — messages.stream,
 * tool_use blocks, input_json_delta beat tallying, idle-abort, keepalives, the
 * <tool_calls> text fallback. Rather than fork ~1,900 lines of that for a second
 * provider, this module speaks the same surface and translates to KIE's
 * Responses API underneath. Call sites don't change; only getAnthropicClient
 * decides which object they get.
 *
 * Three things about the upstream endpoint drive the design:
 *
 *   (1) It's Codex. Without an `instructions` field the relay injects a
 *       ~12k-character "You are Codex, a coding agent" system prompt that
 *       fights ours. We ALWAYS send instructions, even when the caller
 *       passed no system prompt.
 *
 *   (2) Structured output replaces tool calling. A forced tool_choice plus a
 *       single tool's input_schema becomes text.format = json_schema in strict
 *       mode, which is a stronger guarantee than tool_choice ever was — so the
 *       fake-<tool_calls>-text failure mode Opus has simply doesn't arise here.
 *       Strict mode needs additionalProperties:false on every object node,
 *       which strictify() adds.
 *
 *   (3) max_output_tokens is currently ignored upstream (asked for 64, got
 *       3,369). We still send it so we inherit the ceiling if that's fixed, and
 *       still map an incomplete status onto stop_reason "max_tokens" so the
 *       existing truncation-split recovery would engage if it ever fires.
 */

const KIE_GPT_URL = "https://api.kie.ai/codex/v1/responses";

// Displaces the Codex persona when a caller sends no system prompt of its own.
const DEFAULT_INSTRUCTIONS = "Follow the user's instructions exactly. Return only what is asked for.";

type CacheControl = { type: string } | undefined;

interface TextBlockParam {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

interface MessageParam {
  role: "user" | "assistant";
  content: string | Array<TextBlockParam | { type: string; [k: string]: unknown }>;
}

interface ToolParam {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface KieGptCreateParams {
  model: string;
  max_tokens?: number;
  system?: string | TextBlockParam[];
  messages: MessageParam[];
  tools?: ToolParam[];
  tool_choice?: unknown;
  // Accepted and ignored — Claude-only knobs that modelParamsFor may spread in.
  thinking?: unknown;
}

export interface KieGptRequestOptions {
  signal?: AbortSignal;
}

type ContentBlock =
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "text"; text: string };

export interface KieGptMessage {
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

// Only the event shapes prompts-core actually branches on. Everything else it
// treats as "activity" and uses purely to reset the idle timer.
type StreamEvent =
  | { type: "content_block_delta"; index: number; delta: { type: "input_json_delta"; partial_json: string } }
  | { type: "ping" };

/**
 * OpenAI strict json_schema requires additionalProperties:false on every object
 * and every property listed in `required`. Our hand-written schemas
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

/** Flattens Anthropic's system field (string or text blocks) into the single
 *  instructions string the Responses API takes. cache_control is dropped —
 *  there's no prompt-cache equivalent on this endpoint. */
function toInstructions(system: KieGptCreateParams["system"]): string {
  if (!system) return DEFAULT_INSTRUCTIONS;
  if (typeof system === "string") return system.trim() || DEFAULT_INSTRUCTIONS;
  const joined = system
    .filter((b) => b?.type === "text")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
  return joined || DEFAULT_INSTRUCTIONS;
}

function toInput(messages: MessageParam[]): Array<Record<string, unknown>> {
  return messages.map((m) => {
    if (typeof m.content === "string") {
      return { role: m.role, content: [{ type: "input_text", text: m.content }] };
    }
    const parts = m.content.map((b) => {
      if (b.type === "text") return { type: "input_text", text: (b as TextBlockParam).text };
      // Throw rather than drop. Silently discarding an image block would send
      // a vision prompt with no image and get back confident nonsense — far
      // worse than a loud failure. If a GPT-eligible step ever needs images,
      // map them to { type: "input_image", image_url } here (the endpoint
      // supports it) instead of relaxing this guard.
      throw new Error(
        `KIE GPT client: unsupported content block "${b.type}". Only text blocks are translated; ` +
        `route this call to Claude (getAnthropicClient's forceProvider option) or add a mapping.`,
      );
    });
    return { role: m.role, content: parts };
  });
}

function buildBody(params: KieGptCreateParams, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    stream,
    instructions: toInstructions(params.system),
    input: toInput(params.messages),
  };
  if (params.max_tokens) body.max_output_tokens = params.max_tokens;

  // A forced single-tool call is really a demand for one JSON object matching
  // the tool's schema, which is exactly what json_schema mode expresses.
  const tool = params.tools?.[0];
  if (tool) {
    body.text = {
      format: {
        type: "json_schema",
        name: tool.name,
        strict: true,
        schema: strictify(tool.input_schema),
      },
    };
  }
  return body;
}

/** Error carrying an HTTP-ish status so retryClaudeCall (lib/claude/retry.ts)
 *  can tell a transient 5xx from a permanent 4xx. */
class KieGptError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "KieGptError";
    this.status = status;
  }
}

/** KIE wraps its own failures as HTTP 200 `{ code: 4xx/5xx, msg, data: null }`.
 *  Detect that and surface it as a real error with the inner status, mirroring
 *  what makeFetchViaKie does for the Claude path. */
function throwIfEnvelopeError(parsed: unknown, fallbackStatus: number): void {
  if (!parsed || typeof parsed !== "object") return;
  const env = parsed as { code?: unknown; msg?: unknown };
  if (typeof env.code === "number" && env.code >= 400) {
    throw new KieGptError(typeof env.msg === "string" ? env.msg : `KIE error ${env.code}`, env.code);
  }
  if (fallbackStatus >= 400) {
    throw new KieGptError(`KIE GPT error ${fallbackStatus}`, fallbackStatus);
  }
}

function readUsage(res: Record<string, unknown> | null): KieGptMessage["usage"] {
  const u = (res?.usage ?? {}) as {
    input_tokens?: number;
    output_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
  return {
    input_tokens: u.input_tokens ?? 0,
    output_tokens: u.output_tokens ?? 0,
    cache_read_input_tokens: u.input_tokens_details?.cached_tokens ?? 0,
    cache_creation_input_tokens: 0,
  };
}

/** Pulls the assistant's text out of the Responses `output` array, skipping the
 *  reasoning items (whose content is encrypted and useless to us). */
function readOutputText(res: Record<string, unknown> | null): string {
  const output = (res?.output ?? []) as Array<{ type?: string; content?: Array<{ text?: string }> }>;
  return output
    .filter((o) => o?.type === "message")
    .flatMap((o) => o.content ?? [])
    .map((c) => c?.text ?? "")
    .join("");
}

/**
 * Turns the accumulated JSON text into the message prompts-core expects.
 *
 * On success that's a synthetic tool_use block, so the tool_use branch at every
 * call site works untouched. On a parse failure we deliberately return a TEXT
 * block instead: prompts-core already falls back to extractToolInputFromText
 * for exactly this case on the Claude path, so a malformed response lands in a
 * recovery path that already exists rather than a new one.
 */
function toMessage(
  params: KieGptCreateParams,
  raw: string,
  responseObj: Record<string, unknown> | null,
): KieGptMessage {
  const id = (responseObj?.id as string) ?? `kie_gpt_${Date.now()}`;
  const toolName = params.tools?.[0]?.name;
  const status = responseObj?.status as string | undefined;

  let content: ContentBlock[];
  if (toolName) {
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
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
    // Nothing truncates today (max_output_tokens is ignored upstream), but map
    // it anyway so the existing truncation-split recovery engages if that changes.
    stop_reason: status === "incomplete" ? "max_tokens" : "end_turn",
    stop_sequence: null,
    usage: readUsage(responseObj),
  };
}

/**
 * Streaming handle. Async-iterable of Anthropic-shaped events, plus
 * finalMessage(). The request starts on first iteration (or on finalMessage()
 * if the caller never iterates), matching how the SDK behaves.
 */
class KieGptStream {
  private started = false;
  private settled = false;
  private final: KieGptMessage | null = null;
  private failure: unknown = null;
  private waiters: Array<() => void> = [];

  constructor(
    private readonly apiKey: string,
    private readonly params: KieGptCreateParams,
    private readonly creditsRef: { value: number | null },
    private readonly signal?: AbortSignal,
  ) {}

  private settle(): void {
    this.settled = true;
    for (const w of this.waiters) w();
    this.waiters = [];
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<StreamEvent> {
    this.started = true;
    let res: Response;
    try {
      res = await fetch(KIE_GPT_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          "User-Agent": "heclus-engine/1.0",
        },
        body: JSON.stringify(buildBody(this.params, true)),
        signal: this.signal,
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
        err = new KieGptError(`KIE GPT returned ${contentType || "no content-type"}`, res.status || 500);
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
    let responseObj: Record<string, unknown> | null = null;
    let index = 0;

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
          let evt: Record<string, unknown>;
          try {
            evt = JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
          } catch {
            continue;
          }

          const type = evt.type as string | undefined;
          if (type === "response.output_text.delta") {
            const delta = (evt.delta as string) ?? "";
            accum += delta;
            // The model's text IS the tool input here, so it maps onto
            // input_json_delta — which is what the beat tally counts.
            yield { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: delta } };
          } else if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
            responseObj = (evt.response as Record<string, unknown>) ?? null;
            // On the SSE path KIE hangs credits_consumed off the EVENT, as a
            // sibling of `response` — not inside it, the way the non-streaming
            // body does. Check both so neither shape silently logs no cost.
            const credits = evt.credits_consumed ?? responseObj?.credits_consumed;
            if (typeof credits === "number") this.creditsRef.value = credits;
            if (type === "response.failed") {
              throw new KieGptError("KIE GPT reported response.failed", 500);
            }
          } else if (type === "error") {
            const msg = (evt.message as string) ?? "KIE GPT stream error";
            throw new KieGptError(msg, 500);
          } else {
            // Any other event still counts as activity — prompts-core resets
            // its idle timer on every yielded event.
            yield { type: "ping" };
          }
        }
      }
      this.final = toMessage(this.params, accum, responseObj);
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

  async finalMessage(): Promise<KieGptMessage> {
    if (this.final) return this.final;
    if (this.failure) throw this.failure;

    if (!this.started) {
      // Caller never iterated — drive the stream to completion ourselves.
      for await (const _ of this) void _;
    } else if (!this.settled) {
      // Iteration is still in flight; wait for it to finish.
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }

    if (this.failure) throw this.failure;
    if (!this.final) {
      // Reached when the consumer broke out of the loop early (cancellation).
      throw new KieGptError("KIE GPT stream ended without a final message", 500);
    }
    return this.final;
  }
}

/**
 * The client handed to prompts-core in place of `new Anthropic(...)`.
 * Implements only `messages.create` and `messages.stream` — the entire surface
 * the prompt steps use.
 */
export class KieGptClient {
  readonly messages: {
    create: (params: KieGptCreateParams, options?: KieGptRequestOptions) => Promise<KieGptMessage>;
    stream: (params: KieGptCreateParams, options?: KieGptRequestOptions) => KieGptStream;
  };

  constructor(
    private readonly apiKey: string,
    private readonly creditsRef: { value: number | null },
  ) {
    this.messages = {
      create: (params, options) => this.create(params, options),
      stream: (params, options) => new KieGptStream(this.apiKey, params, this.creditsRef, options?.signal),
    };
  }

  private async create(params: KieGptCreateParams, options?: KieGptRequestOptions): Promise<KieGptMessage> {
    const res = await fetch(KIE_GPT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "User-Agent": "heclus-engine/1.0",
      },
      body: JSON.stringify(buildBody(params, false)),
      signal: options?.signal,
    });

    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new KieGptError(`KIE GPT returned non-JSON (${res.status})`, res.status || 500);
    }

    throwIfEnvelopeError(parsed, res.status);

    const responseObj = parsed as Record<string, unknown>;
    const credits = responseObj.credits_consumed;
    if (typeof credits === "number") this.creditsRef.value = credits;

    return toMessage(params, readOutputText(responseObj), responseObj);
  }
}
