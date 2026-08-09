/**
 * An Anthropic-shaped facade over KIE's GPT relay (the Responses API).
 * Shared machinery — strictify, the stream driver, message synthesis, error
 * handling — lives in kieShared.ts; this file is only the dialect.
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
 *       fake-<tool_calls>-text failure mode Opus has doesn't arise here.
 *
 *   (3) max_output_tokens is currently ignored upstream (asked for 64, got
 *       3,369). We still send it so we inherit the ceiling if that's fixed.
 *
 * Known upstream flakiness: a meaningful share of calls return an empty or
 * mid-stream-truncated body with stop_reason end_turn, zero output tokens and
 * no credits charged. That surfaces as an unparseable/empty response, which
 * prompts-core already treats as retryable via retryClaudeCall.
 */

import {
  KieStream,
  ParsedEvent,
  UsageLike,
  flattenContent,
  flattenSystem,
  kiePost,
  strictify,
  toMessage,
  type KieCreateParams,
  type KieMessage,
  type KieRequestOptions,
} from "./kieShared";

const KIE_GPT_URL = "https://api.kie.ai/codex/v1/responses";

// Displaces the Codex persona when a caller sends no system prompt of its own.
const DEFAULT_INSTRUCTIONS = "Follow the user's instructions exactly. Return only what is asked for.";

export { strictify };
export type KieGptCreateParams = KieCreateParams;

function buildBody(params: KieCreateParams, stream: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: params.model,
    stream,
    instructions: flattenSystem(params.system, DEFAULT_INSTRUCTIONS),
    input: params.messages.map((m) => ({
      role: m.role,
      content: flattenContent(m.content, "GPT").map((text) => ({ type: "input_text", text })),
    })),
  };
  if (params.max_tokens) body.max_output_tokens = params.max_tokens;

  // A forced single-tool call is really a demand for one JSON object matching
  // the tool's schema, which is exactly what json_schema mode expresses.
  const tool = params.tools?.[0];
  if (tool) {
    body.text = {
      format: { type: "json_schema", name: tool.name, strict: true, schema: strictify(tool.input_schema) },
    };
  }
  return body;
}

function parseEvent(evt: Record<string, unknown>): ParsedEvent {
  const type = evt.type as string | undefined;

  if (type === "response.output_text.delta") {
    return { delta: (evt.delta as string) ?? "" };
  }
  if (type === "response.completed" || type === "response.incomplete" || type === "response.failed") {
    const responseObj = (evt.response as Record<string, unknown>) ?? null;
    // On the SSE path KIE hangs credits_consumed off the EVENT, as a sibling of
    // `response` — not inside it, the way the non-streaming body does. Check
    // both so neither shape silently logs no cost.
    const credits = evt.credits_consumed ?? responseObj?.credits_consumed;
    return {
      credits: typeof credits === "number" ? credits : undefined,
      error: type === "response.failed" ? "KIE GPT reported response.failed" : undefined,
      final: {
        id: responseObj?.id as string | undefined,
        truncated: (responseObj?.status as string | undefined) === "incomplete",
        usage: (responseObj?.usage as UsageLike) ?? null,
      },
    };
  }
  if (type === "error") {
    return { error: (evt.message as string) ?? "KIE GPT stream error" };
  }
  return {};
}

/** Pulls the assistant's text out of the Responses `output` array, skipping the
 *  reasoning items (whose content is encrypted and useless to us). */
function readOutputText(res: Record<string, unknown>): string {
  const output = (res.output ?? []) as Array<{ type?: string; content?: Array<{ text?: string }> }>;
  return output
    .filter((o) => o?.type === "message")
    .flatMap((o) => o.content ?? [])
    .map((c) => c?.text ?? "")
    .join("");
}

export class KieGptClient {
  readonly messages: {
    create: (params: KieCreateParams, options?: KieRequestOptions) => Promise<KieMessage>;
    stream: (params: KieCreateParams, options?: KieRequestOptions) => KieStream;
  };

  constructor(
    private readonly apiKey: string,
    private readonly creditsRef: { value: number | null },
  ) {
    this.messages = {
      create: (params, options) => this.create(params, options),
      stream: (params, options) =>
        new KieStream({
          url: KIE_GPT_URL,
          apiKey: this.apiKey,
          body: buildBody(params, true),
          params,
          creditsRef: this.creditsRef,
          signal: options?.signal,
          provider: "GPT",
          parseEvent,
        }),
    };
  }

  private async create(params: KieCreateParams, options?: KieRequestOptions): Promise<KieMessage> {
    const payload = await kiePost(KIE_GPT_URL, this.apiKey, buildBody(params, false), this.creditsRef, options?.signal);
    return toMessage(params, readOutputText(payload), {
      id: payload.id as string | undefined,
      truncated: (payload.status as string | undefined) === "incomplete",
      usage: (payload.usage as UsageLike) ?? null,
    });
  }
}
