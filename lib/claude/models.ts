import { supabase } from "@/lib/supabase/client";
import { getSettings } from "@/lib/settings";
import { getRoutingForUser, isClientPaid, isWorkflowStep, type WorkflowStep } from "@/lib/claude/routing";
import { getModelForProvider, getPromptProvider, isKieProvider } from "@/lib/claude/providers";
import { meetsTier, tierForPlan, tierRank, planSlugOf } from "@/lib/plans-gating";
import { isAdminUser } from "@/lib/admin";
import type { User } from "@supabase/supabase-js";

// The default Claude model for the workflow steps, selectable in the admin
// dashboard under Config → Anthropic → Model (product_config.default_claude_model,
// migration 105).

/** What the engine ran on before this setting existed. Used when the config
 *  row can't be read or holds an id we don't recognise, so one bad value
 *  can't take every Claude call down with it. */
export const CLAUDE_MODEL_FALLBACK = "claude-opus-4-7";

/** What a user sees instead of a raw model id. Grouping by tier lets the
 *  underlying id change without confusing anyone who picked "Fastest". */
export type ClaudeModelTier = "quality" | "balanced" | "fast";

export const TIER_LABELS: Record<ClaudeModelTier, string> = {
  quality: "Best quality",
  balanced: "Balanced",
  fast: "Fastest",
};

/** What we send for `thinking`, which is not the same question per model:
 *  - "off"     — the model doesn't think unless asked; send nothing.
 *  - "pin-off" — thinking is on by default and max_tokens is a ceiling on
 *                thinking PLUS the answer, so we pin it off to keep the
 *                behaviour the tighter steps (1500–2048) were tuned against.
 *  - "always"  — thinking can't be turned off at all (a 400, not a warning),
 *                so max_tokens has to cover thinking plus the answer. */
export type ClaudeThinkingMode = "off" | "pin-off" | "always";

export type ClaudeModelOption = {
  id: string;
  label: string;
  note: string;
  tier: ClaudeModelTier;
  thinking: ClaudeThinkingMode;
};

// Mythos 5 is deliberately absent: it's Project Glasswing only.
export const CLAUDE_MODELS: ClaudeModelOption[] = [
  { id: "claude-fable-5", label: "Fable 5", tier: "quality", note: "Most capable, and the most expensive ($10/$50 per Mtok). Always thinks and needs 30-day retention.", thinking: "always" },
  { id: "claude-opus-5", label: "Opus 5", tier: "quality", note: "Newest Opus. Strongest on long agentic and structured work.", thinking: "pin-off" },
  { id: "claude-opus-4-8", label: "Opus 4.8", tier: "quality", note: "Previous Opus flagship. Warmer prose, narrates more.", thinking: "off" },
  { id: "claude-opus-4-7", label: "Opus 4.7", tier: "quality", note: "What the engine shipped on. Literal instruction following.", thinking: "off" },
  { id: "claude-opus-4-6", label: "Opus 4.6", tier: "quality", note: "Older Opus. Kept for comparison against a known baseline.", thinking: "off" },
  { id: "claude-sonnet-5", label: "Sonnet 5", tier: "balanced", note: "Near-Opus quality on structured output at Sonnet pricing.", thinking: "pin-off" },
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6", tier: "balanced", note: "Previous Sonnet. Cheaper than Opus, weaker on long scripts.", thinking: "off" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", tier: "fast", note: "Cheapest and fastest. Looser tool_choice adherence.", thinking: "off" },
];

/** USD per million tokens, for the cost readouts in the admin dashboard.
 *  `intro` is a launch price that expires — after `introUntil` the list rate
 *  applies, so a figure shown today stays right next month without an edit.
 *  Cache reads bill at 0.1x input and 5-minute cache writes at 1.25x; neither
 *  is modelled here because the steps these numbers describe don't cache. */
export type ClaudeModelPrice = {
  in: number;
  out: number;
  intro?: { in: number; out: number; until: string };
};

export const CLAUDE_MODEL_PRICING: Record<string, ClaudeModelPrice> = {
  "claude-fable-5": { in: 10, out: 50 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-opus-4-8": { in: 5, out: 25 },
  "claude-opus-4-7": { in: 5, out: 25 },
  "claude-opus-4-6": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 3, out: 15, intro: { in: 2, out: 10, until: "2026-08-31" } },
  "claude-sonnet-4-6": { in: 3, out: 15 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

/** The rate in force on `on` (defaults to now), so intro pricing expires by
 *  itself rather than needing a follow-up edit. */
export function claudeRateFor(modelId: string, on: Date = new Date()): ClaudeModelPrice | null {
  const price = CLAUDE_MODEL_PRICING[modelId];
  if (!price) return null;
  if (price.intro && on <= new Date(`${price.intro.until}T23:59:59Z`)) {
    return { in: price.intro.in, out: price.intro.out, intro: price.intro };
  }
  return { in: price.in, out: price.out };
}

/** Steps where a user's own pick is honoured. Deliberately only the
 *  high-volume prompt grind: those runs are where model cost actually adds
 *  up and where a weaker model degrades output least visibly. Channel
 *  analysis, ideas, and script stay on the admin default — analysis feeds
 *  styleDNA into everything downstream, and the script is what customers
 *  judge the product on. */
export const USER_CHOICE_STEPS = new Set<WorkflowStep>([
  "beats",
  "image_prompts",
  "video_prompts",
  "thumbnails",
]);

export function isSelectableClaudeModel(id: unknown): id is string {
  return typeof id === "string" && CLAUDE_MODELS.some((m) => m.id === id);
}

export function claudeModelLabel(id: string): string {
  return CLAUDE_MODELS.find((m) => m.id === id)?.label ?? id;
}

/** Everything a messages.create call needs to run on the configured model:
 *  the id, plus the thinking pin when the model would otherwise think and
 *  eat into max_tokens. Spread it into the request. */
export type ClaudeModelParams = {
  model: string;
  thinking?: { type: "disabled" };
};

export function modelParamsFor(id: string): ClaudeModelParams {
  const opt = CLAUDE_MODELS.find((m) => m.id === id);
  // "always" must send no thinking field at all — an explicit disabled is a 400.
  return opt?.thinking === "pin-off" ? { model: id, thinking: { type: "disabled" } } : { model: id };
}

/** Enough room for an answer on a model that cannot stop thinking.
 *
 *  Sized against the largest of the tight steps rather than the smallest, since
 *  the cost of being generous is nothing: max_tokens is a ceiling, and a step
 *  that finishes in 900 tokens is billed for 900. */
export const ALWAYS_THINKING_FLOOR = 8192;

/**
 * The budget to actually send, given the model.
 *
 * For most models this is the number the call site asked for. For a model whose
 * thinking cannot be turned off, max_tokens is a ceiling on the thinking AND
 * the answer, so a budget tuned on a non-thinking model gets spent reasoning
 * and the turn ends at max_tokens with no tool call in it. The caller sees an
 * empty or truncated result and no error, which is the least diagnosable
 * failure this code has.
 *
 * Raised rather than rejected: an admin who picks Fable 5 for a step should get
 * a working step, not a 400 telling them the budget is 2048.
 */
export function maxTokensFor(id: string, requested: number): number {
  const opt = CLAUDE_MODELS.find((m) => m.id === id);
  if (opt?.thinking !== "always") return requested;
  return Math.max(requested, ALWAYS_THINKING_FLOOR);
}

export type ClaudeModelConfig = {
  /** The model every step runs on unless a user pick overrides it. */
  default: string;
  /** Model ids a Pro user may choose. Empty = the feature is off. */
  userSelectable: string[];
  /** Steps that run on something other than the default. Absent means the
   *  default, which is what every step did before this existed. */
  perStep: Partial<Record<WorkflowStep, string>>;
};

/** The steps the prompts run is made of.
 *
 *  Grouped because they are one job to the person configuring them: the prompts
 *  step splits the script into beats and writes an image and a video prompt for
 *  each. It is also the highest-volume Claude work in the product by a wide
 *  margin, which is why it is the one worth pricing separately from the rest. */
export const PROMPT_MODEL_STEPS: WorkflowStep[] = ["beats", "image_prompts", "video_prompts"];

const CACHE_TTL_MS = 15_000;
let cached: { at: number; value: ClaudeModelConfig } | null = null;

const CONFIG_FALLBACK: ClaudeModelConfig = { default: CLAUDE_MODEL_FALLBACK, userSelectable: [], perStep: {} };

/** Cached so a per-step model lookup doesn't hammer Supabase on every
 *  workflow call. Falls back to the shipped model on any error — a
 *  misconfigured row must never block a generation. */
export async function getClaudeModelConfig(): Promise<ClaudeModelConfig> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;

  try {
    const { data } = await supabase
      .from("product_config")
      .select("default_claude_model, user_selectable_claude_models")
      .eq("service", "_global")
      .single();
    const row = data as {
      default_claude_model?: unknown;
      user_selectable_claude_models?: unknown;
    } | null;

    // Asked for separately on purpose. Postgres fails a select naming an
    // unknown column, and this function answers the catch with a hardcoded
    // fallback — so folding claude_model_per_step into the select above would
    // mean that between deploying and running the migration, every step
    // silently ignored the admin's chosen default and ran on opus-4-7.
    let rawPerStep: unknown = null;
    {
      const { data: stepRow } = await supabase
        .from("product_config")
        .select("claude_model_per_step")
        .eq("service", "_global")
        .maybeSingle();
      rawPerStep = (stepRow as Record<string, unknown> | null)?.claude_model_per_step ?? null;
    }

    const raw = row?.user_selectable_claude_models;
    // Same filtering as the allowlist, and for the same reason: a step pinned
    // to a model that has since been retired from the catalog falls back to the
    // default rather than sending an id nothing recognises.
    const perStep: Partial<Record<WorkflowStep, string>> = {};
    if (rawPerStep && typeof rawPerStep === "object") {
      for (const [k, v] of Object.entries(rawPerStep as Record<string, unknown>)) {
        if (isWorkflowStep(k) && isSelectableClaudeModel(v)) perStep[k] = v;
      }
    }

    const value: ClaudeModelConfig = {
      default: isSelectableClaudeModel(row?.default_claude_model) ? row.default_claude_model : CLAUDE_MODEL_FALLBACK,
      // Filtered against the catalog on read, so an id retired from the
      // code can't linger in the DB and be offered to users.
      userSelectable: Array.isArray(raw) ? raw.filter(isSelectableClaudeModel) : [],
      perStep,
    };
    cached = { at: now, value };
    return value;
  } catch {
    return CONFIG_FALLBACK;
  }
}

export async function getDefaultClaudeModel(): Promise<string> {
  return (await getClaudeModelConfig()).default;
}

/** The Claude model a step runs on: its own override, or the default. */
export async function claudeModelForStep(step?: WorkflowStep): Promise<string> {
  const cfg = await getClaudeModelConfig();
  return (step && cfg.perStep[step]) || cfg.default;
}

export function invalidateDefaultClaudeModelCache(): void {
  cached = null;
}

/** The one call sites use for steps that always run the admin default.
 *
 *  Pass the step. Provider is resolved first, exactly as resolveModelForUser
 *  does: a step switched to GPT or Gemini must not be handed a Claude model id,
 *  because getAnthropicClient will have built a KIE facade for it and the relay
 *  rejects the request. Omitting the step keeps the old Claude-only behaviour,
 *  which is right for callers whose step can't change provider.
 *
 *  Pass userId wherever it is available. The media operator switch overrides
 *  the per-step provider, and that decision is per user (BYO accounts stay on
 *  KIE), so without the id this cannot tell whether the override applies and
 *  will hand a GPT model id to a PoYo client that only speaks Anthropic's
 *  Messages API. Omitting it is safe but keeps the step on GPT. */
/** True when this user's routing cannot serve GPT or Gemini, so the step runs
 *  Claude and must be handed a Claude model id.
 *
 *  PoYo and Anthropic both speak the Anthropic Messages API and neither relays
 *  GPT, so both override the per-step provider in getAnthropicClient. This is
 *  the same decision, and it has to give the same answer or the client builds
 *  an Anthropic call around a model id like gpt-5-6-sol. */
async function routingForcesClaude(step: WorkflowStep, userId: string): Promise<boolean> {
  const routing = await getRoutingForUser(userId, step);
  return routing === "heclus_poyo" || routing === "heclus_direct";
}

export async function resolveDefaultModel(step?: WorkflowStep, userId?: string): Promise<ClaudeModelParams> {
  if (step) {
    try {
      const provider = await getPromptProvider(step);
      if (isKieProvider(provider)) {
        const overridden = userId ? await routingForcesClaude(step, userId) : false;
        if (!overridden) return { model: await getModelForProvider(provider, step) };
      }
    } catch {
      // Provider or routing unreadable — fall through to Claude rather than
      // fail the step.
    }
  }
  return modelParamsFor(await claudeModelForStep(step));
}

/** Pro-tier check from a userId, so the one-click orchestrator (which only
 *  carries project.user_id) gets the same gate as the request-scoped routes.
 *  Pass `user` when you already have it to skip the auth lookup. */
async function isProTierById(userId: string, user?: User | null): Promise<boolean> {
  if (user) return isAdminUser(user) || meetsTier(user, "pro");
  try {
    const { data } = await supabase.auth.admin.getUserById(userId);
    if (isAdminUser(data?.user)) return true;
    const meta = (data?.user?.app_metadata ?? {}) as { plan?: unknown };
    const slug = typeof meta.plan === "string" && meta.plan.trim() ? meta.plan.trim().toLowerCase() : "starter";
    return tierRank(tierForPlan(slug)) >= tierRank("pro");
  } catch {
    // Fail closed: an unreadable plan means no upgrade, never a free one.
    return false;
  }
}

/**
 * The model for one step, honouring a user's own pick where that's allowed.
 * Falls through to the admin default unless EVERY condition holds:
 *
 *   1. the step is one users may choose for (USER_CHOICE_STEPS),
 *   2. the step routes through the user's own KIE key (client_kie) — so a
 *      user can never pick a model that Heclus's key pays for,
 *   3. the admin has allowlisted at least one model,
 *   4. the user is on a Pro-tier plan (or is an admin),
 *   5. their stored pick is still on the allowlist.
 *
 * Any failure is silent and lands on the admin default: a model preference
 * must never be the reason a generation errors.
 */
export async function resolveModelForUser(
  userId: string,
  step: WorkflowStep,
  user?: User | null,
): Promise<ClaudeModelParams> {
  // Provider first: on GPT/Gemini the Claude catalog is irrelevant, and a Pro
  // user's Claude pick must not leak onto those clients. modelParamsFor returns
  // a bare { model } for ids outside CLAUDE_MODELS, which is what the facades
  // want — no `thinking` field.
  try {
    const provider = await getPromptProvider(step);
    if (isKieProvider(provider)) {
      // The media operator switch overrides the per-step provider, and the
      // model has to follow it. getAnthropicClient makes the same call and
      // hands back a PoYo client speaking Anthropic's Messages API; returning
      // a GPT model id here would then send gpt-5-6-sol to /v1/messages, which
      // PoYo rejects outright:
      //
      //   URI '/v1/messages' is not supported by this model.
      //   Supported URIs: ['/codex/v1/responses', '/v1/responses']
      //
      // Falling through gives the Claude default instead. Both sites ask
      // routingForcesClaude now, so the client and the model can no longer
      // disagree about which provider is answering: they did, and channel
      // analysis kept billing kie_credits on gpt-5-6-sol while the writing
      // steps were switched to Anthropic.
      if (!(await routingForcesClaude(step, userId))) {
        return { model: await getModelForProvider(provider, step) };
      }
    }
  } catch {
    // Provider or routing unreadable — fall through to Claude rather than fail
    // the step.
  }

  const config = await getClaudeModelConfig();
  // The step's own model, not the global default: an admin who moved the
  // prompts steps onto Sonnet meant it for the users who fall through here too.
  const fallback = modelParamsFor(config.perStep[step] || config.default);

  if (!USER_CHOICE_STEPS.has(step) || config.userSelectable.length === 0) return fallback;

  // Whose key pays decides whether the choice is the user's to make — which
  // covers their own Anthropic key as well as their KIE one.
  try {
    if (!isClientPaid(await getRoutingForUser(userId, step))) return fallback;
  } catch {
    return fallback;
  }

  if (!(await isProTierById(userId, user))) return fallback;

  try {
    const chosen = (await getSettings(userId)).claude_model;
    if (!chosen || !config.userSelectable.includes(chosen)) return fallback;
    return modelParamsFor(chosen);
  } catch {
    return fallback;
  }
}
