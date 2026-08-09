/**
 * An Anthropic-shaped facade over KIE's Gemini relay (OpenAI chat/completions).
 * Shared machinery lives in kieShared.ts; this file is only the dialect.
 *
 * Differences from the GPT relay that matter:
 *
 *   (1) The model id is part of the URL, not just the body:
 *       https://api.kie.ai/<model-id>/v1/chat/completions
 *       Posting a known model to the wrong path returns KIE's envelope
 *       `{code: 422, msg: "The model is not supported"}`.
 *
 *   (2) Structured output is `response_format: {type: "json_schema", ...}`,
 *       the chat/completions spelling, rather than `text.format`. We prefer it
 *       over Gemini's function-calling: a forced tool call there was observed
 *       returning `{"beats":[null,null]}` — nested objects dropped — while
 *       json_schema returned clean, schema-valid output every time.
 *
 *   (3) No Codex persona to displace, but the system prompt still has to go
 *       somewhere: it becomes a leading `system` message.
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

const DEFAULT_SYSTEM = "Follow the user's instructions exactly. Return only what is asked for.";

/** The relay routes by model id in the path, so the URL is per-model. */
function urlFor(model: string): string {
  return `https://api.kie.ai/${encodeURIComponent(model)}/v1/chat/completions`;
}

function buildBody(params: KieCreateParams, stream: boolean): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: flattenSystem(params.system, DEFAULT_SYSTEM) },
  ];
  for (const m of params.messages) {
    // chat/completions takes one string per message, so the Anthropic block
    // list is joined rather than mapped to parts.
    messages.push({ role: m.role, content: flattenContent(m.content, "Gemini").join("\n\n") });
  }

  const body: Record<string, unknown> = { model: params.model, stream, messages };
  if (params.max_tokens) body.max_tokens = params.max_tokens;

  const tool = params.tools?.[0];
  if (tool) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: tool.name, strict: true, schema: strictify(tool.input_schema) },
    };
  }
  return body;
}

function parseEvent(evt: Record<string, unknown>): ParsedEvent {
  const choices = (evt.choices ?? []) as Array<{
    delta?: { content?: string };
    finish_reason?: string | null;
  }>;
  const choice = choices[0];
  const credits = typeof evt.credits_consumed === "number" ? evt.credits_consumed : undefined;

  // The terminating chunk carries finish_reason plus usage and credits; content
  // chunks carry neither. Both can appear on the same chunk, so read both.
  const out: ParsedEvent = { credits };
  const delta = choice?.delta?.content;
  if (delta) out.delta = delta;
  if (choice?.finish_reason) {
    out.final = {
      id: evt.id as string | undefined,
      truncated: choice.finish_reason === "length",
      usage: (evt.usage as UsageLike) ?? null,
    };
  }
  return out;
}

export class KieGeminiClient {
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
          url: urlFor(params.model),
          apiKey: this.apiKey,
          body: buildBody(params, true),
          params,
          creditsRef: this.creditsRef,
          signal: options?.signal,
          provider: "Gemini",
          parseEvent,
        }),
    };
  }

  private async create(params: KieCreateParams, options?: KieRequestOptions): Promise<KieMessage> {
    const payload = await kiePost(urlFor(params.model), this.apiKey, buildBody(params, false), this.creditsRef, options?.signal);
    const choice = ((payload.choices ?? []) as Array<{ message?: { content?: string }; finish_reason?: string }>)[0];
    return toMessage(params, choice?.message?.content ?? "", {
      id: payload.id as string | undefined,
      truncated: choice?.finish_reason === "length",
      usage: (payload.usage as UsageLike) ?? null,
    });
  }
}
