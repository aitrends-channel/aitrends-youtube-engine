import { supabase } from "@/lib/supabase/client";
import type { AnthropicRouting, WorkflowStep } from "./routing";

/**
 * Which model family generates a step's output. Orthogonal to routing, which
 * decides whose key pays and through which gateway:
 *
 *   claude – Anthropic's Messages API (direct, or resold by KIE)
 *   gpt    – KIE's Responses relay at /codex/v1/responses
 *
 * GPT exists only via KIE, so picking it maps a direct routing to its KIE
 * equivalent (see kieRoutingFor). Whose key pays doesn't change.
 */
export type PromptProvider = "claude" | "gpt" | "gemini";

export function isPromptProvider(v: unknown): v is PromptProvider {
  return v === "claude" || v === "gpt" || v === "gemini";
}

/** True for the providers that reach the model through KIE rather than
 *  Anthropic — i.e. everything except Claude. */
export function isKieProvider(p: PromptProvider): boolean {
  return p === "gpt" || p === "gemini";
}

/**
 * Steps that may run on a non-Claude provider. These all force a single
 * tool_choice, which the GPT and Gemini facades turn into a strict json_schema
 * (see kieGptClient.ts) — a stronger guarantee than tool_choice, and immune to
 * the fake-<tool_calls>-text failure Claude has on these schemas.
 *
 * visual_analysis is the one step that cannot switch: it sends image content
 * blocks, and flattenContent on both KIE facades only translates text (it
 * throws a 400 on anything else). Same reason prompts-from-image pins itself
 * to Claude via getAnthropicClient's forceProvider.
 *
 * Everything listed still defaults to Claude until an admin moves it under
 * Config → Anthropic → Per step. Two are worth watching after a switch:
 *
 *   script — the only long-form prose step, at a 5-6k word target. The GPT
 *   relay ignores max_output_tokens upstream and intermittently returns an
 *   empty body with stop_reason end_turn (see kieGptClient.ts). The script
 *   route now refuses to advance the wizard on an empty result rather than
 *   silently blanking the step, so a bad run is visible, but expect retries.
 *
 *   analyze — feeds styleDNA into every later step, so a quality regression
 *   there is invisible until the finished video is wrong. Move it last.
 *
 * Provider is only half the picture: routing decides the gateway. A step left
 * on the Claude provider with client_kie or heclus_kie routing reaches KIE's
 * /claude endpoint, which is a Cursor agent harness rather than the Anthropic
 * API — it drops tool_choice entirely and answers from whichever Cursor mode
 * it happens to be in. Claude steps belong on heclus_direct or client_direct.
 */
export const PROVIDER_STEPS = new Set<WorkflowStep>([
  "analyze",
  "ideas",
  "script",
  "beats",
  "image_prompts",
  "video_prompts",
  "thumbnails",
]);

export function supportsProviderChoice(step: WorkflowStep): boolean {
  return PROVIDER_STEPS.has(step);
}

/** What the gpt provider runs on when the config row is unreadable or holds an
 *  id we don't recognise. Cheapest of the working models, and it produced valid
 *  output against the production prompt schema. */
export const GPT_MODEL_FALLBACK = "gpt-5-6-luna";

export type GptModelOption = {
  id: string;
  label: string;
  note: string;
};

// Credits are what one identical structured-output call cost during testing —
// indicative ordering, not a quote. gpt-5-2 is deliberately absent: it's listed
// upstream but returns an empty body.
export const GPT_MODELS: GptModelOption[] = [
  { id: "gpt-5-6-luna",  label: "GPT 5.6 Luna",  note: "Cheapest by a wide margin (~0.01 credits/call in testing). The default." },
  { id: "gpt-5-6-terra", label: "GPT 5.6 Terra", note: "Mid tier (~0.11). Try this first if Luna's prompts read thin." },
  { id: "gpt-5-4",       label: "GPT 5.4",       note: "Older generation (~0.16). Kept as a comparison baseline." },
  { id: "gpt-5-6-sol",   label: "GPT 5.6 Sol",   note: "Higher tier (~0.25)." },
  { id: "gpt-5-5",       label: "GPT 5.5",       note: "Most expensive of the set (~0.31)." },
];

export function isSelectableGptModel(id: unknown): id is string {
  return typeof id === "string" && GPT_MODELS.some((m) => m.id === id);
}

export function gptModelLabel(id: string): string {
  return GPT_MODELS.find((m) => m.id === id)?.label ?? id;
}

/** Fastest and cheapest of the working Gemini models, and reliable once the
 *  shared facade unwraps its markdown-fenced JSON. */
export const GEMINI_MODEL_FALLBACK = "gemini-3-flash";

// Notes carry the measured trade-offs: on a production-scale 200-word chunk
// (20 beats out) flash finished in ~19s at ~1.2 credits, 3.1-pro in ~53s at
// ~1.8. Flash returns the whole payload in one chunk, so the beat-progress bar
// won't move until it lands.
export const GEMINI_MODELS: GptModelOption[] = [
  { id: "gemini-3-flash",   label: "Gemini 3 Flash",   note: "Fastest of the set (~19s/chunk) and reliable. Arrives in one chunk, so beat progress won't tick mid-chunk. The default." },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", note: "Previous flash generation. Kept as a cheaper comparison baseline." },
  { id: "gemini-3.1-pro",   label: "Gemini 3.1 Pro",   note: "Strongest Gemini here. ~53s/chunk, streams in pieces so progress ticks. Costs more than flash." },
  { id: "gemini-3-pro",     label: "Gemini 3 Pro",     note: "Previous pro generation." },
  { id: "gemini-2.5-pro",   label: "Gemini 2.5 Pro",   note: "Older pro. Comparison baseline." },
];

export function isSelectableGeminiModel(id: unknown): id is string {
  return typeof id === "string" && GEMINI_MODELS.some((m) => m.id === id);
}

/** The model catalog for one provider. Claude has its own catalog in
 *  lib/claude/models.ts, so this only covers the KIE-hosted families. */
export function modelsForProvider(p: PromptProvider): GptModelOption[] {
  return p === "gpt" ? GPT_MODELS : p === "gemini" ? GEMINI_MODELS : [];
}

/**
 * The KIE routing equivalent of any routing. GPT is only reachable through
 * KIE, so a step routed straight to Anthropic has to fall back to the KIE key
 * belonging to the same payer — Heclus's for heclus_*, the client's otherwise.
 */
export function kieRoutingFor(routing: AnthropicRouting): AnthropicRouting {
  return routing === "heclus_direct" || routing === "heclus_kie" ? "heclus_kie" : "client_kie";
}

export type PromptProviderConfig = {
  /** Per-step overrides. A missing key means claude. */
  perStep: Partial<Record<WorkflowStep, PromptProvider>>;
  /** Model the gpt provider runs on. */
  gptModel: string;
  /** Model the gemini provider runs on. */
  geminiModel: string;
};

const CACHE_TTL_MS = 15_000;
let cached: { at: number; value: PromptProviderConfig } | null = null;

const CONFIG_FALLBACK: PromptProviderConfig = {
  perStep: {},
  gptModel: GPT_MODEL_FALLBACK,
  geminiModel: GEMINI_MODEL_FALLBACK,
};

function sanitisePerStep(raw: unknown): Partial<Record<WorkflowStep, PromptProvider>> {
  if (!raw || typeof raw !== "object") return {};
  const out: Partial<Record<WorkflowStep, PromptProvider>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    // Filtered against PROVIDER_STEPS on read, so a slug that was valid when
    // written can't keep steering a step we've since taken off the feature.
    if (PROVIDER_STEPS.has(k as WorkflowStep) && isPromptProvider(v)) out[k as WorkflowStep] = v;
  }
  return out;
}

/** Cached so a per-step lookup doesn't hammer Supabase on every workflow call.
 *  Falls back to Claude on any error — a provider preference must never be the
 *  reason a generation fails. */
export async function getPromptProviderConfig(): Promise<PromptProviderConfig> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;

  try {
    type Row = {
      prompt_provider_per_step?: unknown;
      default_gpt_model?: unknown;
      default_gemini_model?: unknown;
    };

    // Migrations here are applied by hand, so code can land before its column
    // does. PostgREST fails the WHOLE select on one unknown column, which would
    // wipe perStep and silently drop every step back to Claude — sending
    // prompts to a relay the admin deliberately switched away from. So try the
    // current shape, and on failure fall back to the previous one and use the
    // code default for whatever is missing.
    let row: Row | null = null;
    const full = await supabase
      .from("product_config")
      .select("prompt_provider_per_step, default_gpt_model, default_gemini_model")
      .eq("service", "_global")
      .single();

    if (full.error) {
      const prior = await supabase
        .from("product_config")
        .select("prompt_provider_per_step, default_gpt_model")
        .eq("service", "_global")
        .single();
      if (prior.error) return CONFIG_FALLBACK;
      row = prior.data as Row;
    } else {
      row = full.data as Row;
    }

    const value: PromptProviderConfig = {
      perStep: sanitisePerStep(row?.prompt_provider_per_step),
      gptModel: isSelectableGptModel(row?.default_gpt_model) ? row.default_gpt_model : GPT_MODEL_FALLBACK,
      geminiModel: isSelectableGeminiModel(row?.default_gemini_model) ? row.default_gemini_model : GEMINI_MODEL_FALLBACK,
    };
    cached = { at: now, value };
    return value;
  } catch {
    return CONFIG_FALLBACK;
  }
}

export function invalidatePromptProviderCache(): void {
  cached = null;
}

/** The provider one step actually runs on. Always claude for steps outside
 *  PROVIDER_STEPS, whatever the stored map says. */
export async function getPromptProvider(step?: WorkflowStep): Promise<PromptProvider> {
  if (!step || !PROVIDER_STEPS.has(step)) return "claude";
  try {
    return (await getPromptProviderConfig()).perStep[step] ?? "claude";
  } catch {
    return "claude";
  }
}

/** The GPT model id for the gpt provider. */
export async function getGptModel(): Promise<string> {
  return (await getPromptProviderConfig()).gptModel;
}

/** The model id a KIE provider runs on. Claude has its own resolver in
 *  lib/claude/models.ts and never reaches here. */
export async function getModelForProvider(p: PromptProvider): Promise<string> {
  const cfg = await getPromptProviderConfig();
  return p === "gemini" ? cfg.geminiModel : cfg.gptModel;
}
