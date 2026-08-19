import { supabase } from "@/lib/supabase/client";
import { getSettings } from "@/lib/settings";
import { getRoutingForUser, isClientPaid, type WorkflowStep } from "@/lib/claude/routing";
import { getModelForProvider, getPromptProvider, isKieProvider } from "@/lib/claude/providers";
import { PRO_TIER_PLANS, planSlugOf } from "@/lib/plans-gating";
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

export type ClaudeModelConfig = {
  /** The model every step runs on unless a user pick overrides it. */
  default: string;
  /** Model ids a Pro user may choose. Empty = the feature is off. */
  userSelectable: string[];
};

const CACHE_TTL_MS = 15_000;
let cached: { at: number; value: ClaudeModelConfig } | null = null;

const CONFIG_FALLBACK: ClaudeModelConfig = { default: CLAUDE_MODEL_FALLBACK, userSelectable: [] };

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

    const raw = row?.user_selectable_claude_models;
    const value: ClaudeModelConfig = {
      default: isSelectableClaudeModel(row?.default_claude_model) ? row.default_claude_model : CLAUDE_MODEL_FALLBACK,
      // Filtered against the catalog on read, so an id retired from the
      // code can't linger in the DB and be offered to users.
      userSelectable: Array.isArray(raw) ? raw.filter(isSelectableClaudeModel) : [],
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

export function invalidateDefaultClaudeModelCache(): void {
  cached = null;
}

/** The one call sites use for steps that always run the admin default.
 *
 *  Pass the step. Provider is resolved first, exactly as resolveModelForUser
 *  does: a step switched to GPT or Gemini must not be handed a Claude model id,
 *  because getAnthropicClient will have built a KIE facade for it and the relay
 *  rejects the request. Omitting the step keeps the old Claude-only behaviour,
 *  which is right for callers whose step can't change provider. */
export async function resolveDefaultModel(step?: WorkflowStep): Promise<ClaudeModelParams> {
  if (step) {
    try {
      const provider = await getPromptProvider(step);
      if (isKieProvider(provider)) return { model: await getModelForProvider(provider, step) };
    } catch {
      // Provider unreadable — fall through to Claude rather than fail the step.
    }
  }
  return modelParamsFor(await getDefaultClaudeModel());
}

/** Pro-tier check from a userId, so the one-click orchestrator (which only
 *  carries project.user_id) gets the same gate as the request-scoped routes.
 *  Pass `user` when you already have it to skip the auth lookup. */
async function isProTierById(userId: string, user?: User | null): Promise<boolean> {
  if (user) return isAdminUser(user) || PRO_TIER_PLANS.has(planSlugOf(user));
  try {
    const { data } = await supabase.auth.admin.getUserById(userId);
    if (isAdminUser(data?.user)) return true;
    const meta = (data?.user?.app_metadata ?? {}) as { plan?: unknown };
    const slug = typeof meta.plan === "string" && meta.plan.trim() ? meta.plan.trim().toLowerCase() : "starter";
    return PRO_TIER_PLANS.has(slug);
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
    if (isKieProvider(provider)) return { model: await getModelForProvider(provider, step) };
  } catch {
    // Provider unreadable — fall through to Claude rather than fail the step.
  }

  const config = await getClaudeModelConfig();
  const fallback = modelParamsFor(config.default);

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
