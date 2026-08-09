import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";
import { WORKFLOW_STEPS, isWorkflowStep, type AnthropicRouting, type WorkflowStep } from "@/lib/claude/routing";
import {
  CLAUDE_MODELS,
  CLAUDE_MODEL_FALLBACK,
  USER_CHOICE_STEPS,
  getClaudeModelConfig,
  invalidateDefaultClaudeModelCache,
  isSelectableClaudeModel,
} from "@/lib/claude/models";
import {
  GEMINI_MODELS,
  GPT_MODELS,
  PROVIDER_STEPS,
  getPromptProviderConfig,
  invalidatePromptProviderCache,
  isPromptProvider,
  isSelectableGeminiModel,
  isSelectableGptModel,
  type PromptProvider,
} from "@/lib/claude/providers";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

// client_direct is intentionally absent: it is a per-user upgrade of client_kie
// that each client turns on with their own Anthropic key, not a value an admin
// can store globally — set here, it would break every client without one.
const VALID_ROUTINGS = new Set<AnthropicRouting>(["client_kie", "heclus_kie", "heclus_direct"]);

function isAnthropicRouting(v: unknown): v is AnthropicRouting {
  return typeof v === "string" && VALID_ROUTINGS.has(v as AnthropicRouting);
}

function sanitisePerStep(raw: unknown): Partial<Record<WorkflowStep, AnthropicRouting>> {
  if (!raw || typeof raw !== "object") return {};
  const out: Partial<Record<WorkflowStep, AnthropicRouting>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isWorkflowStep(k) && isAnthropicRouting(v)) out[k] = v;
  }
  return out;
}

// Mirrors the reader in lib/claude/providers.ts: only steps still on the
// feature survive a round-trip, so a slug retired from PROVIDER_STEPS can't
// keep steering a step through a stale row.
function sanitiseProviderPerStep(raw: unknown): Partial<Record<WorkflowStep, PromptProvider>> {
  if (!raw || typeof raw !== "object") return {};
  const out: Partial<Record<WorkflowStep, PromptProvider>> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isWorkflowStep(k) && PROVIDER_STEPS.has(k) && isPromptProvider(v)) out[k] = v;
  }
  return out;
}

export async function GET() {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const user = guard.user;

  const { data, error } = await supabase
    .from("product_config")
    .select("anthropic_routing, anthropic_routing_per_step")
    .eq("service", "_global")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Read through the shared resolvers so the tab shows exactly what
  // generation will use, including the allowlist and provider filtering.
  const modelConfig = await getClaudeModelConfig();
  const providerConfig = await getPromptProviderConfig();

  return NextResponse.json({
    routing: data?.anthropic_routing ?? "client_kie",
    per_step: sanitisePerStep(data?.anthropic_routing_per_step),
    steps: WORKFLOW_STEPS,
    model: modelConfig.default,
    models: CLAUDE_MODELS,
    model_fallback: CLAUDE_MODEL_FALLBACK,
    user_selectable_models: modelConfig.userSelectable,
    user_choice_steps: [...USER_CHOICE_STEPS],
    provider_per_step: providerConfig.perStep,
    provider_steps: [...PROVIDER_STEPS],
    gpt_model: providerConfig.gptModel,
    gpt_models: GPT_MODELS,
    gemini_model: providerConfig.geminiModel,
    gemini_models: GEMINI_MODELS,
  });
}

/**
 * PUT body shapes:
 *
 *   { routing: AnthropicRouting }
 *     → updates the global default.
 *
 *   { step: WorkflowStep, routing: AnthropicRouting }
 *     → sets a per-step override for one step.
 *
 *   { step: WorkflowStep, routing: null }
 *     → clears the override for one step (it then inherits from General).
 *
 *   { model: string }
 *     → sets the default Claude model for the workflow steps.
 */
export async function PUT(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;
  const user = guard.user;

  const body = await req.json().catch(() => ({})) as {
    routing?: string | null;
    step?: string;
    steps?: unknown;
    model?: string;
    user_selectable_models?: unknown;
    provider?: unknown;
    gpt_model?: string;
    gemini_model?: string;
  };

  // The admin UI groups the three prompt sub-steps (beats, image prompts,
  // video prompts) into one card, so a single click has to land on both
  // underlying slugs at once. `steps` applies the change to all of them in
  // one read-modify-write, which keeps the group from ever half-saving into a
  // mixed state. `step` (singular) stays for the one-step cards.
  const rawTargets = Array.isArray(body.steps) ? body.steps : body.step !== undefined ? [body.step] : [];
  const invalidTarget = rawTargets.find((s) => !isWorkflowStep(s));
  const targets = rawTargets.filter(isWorkflowStep);

  // Allowlist update path — which models Pro users may choose. An empty
  // array turns the feature off; every user then runs the admin default.
  if (body.user_selectable_models !== undefined) {
    if (!Array.isArray(body.user_selectable_models)) {
      return NextResponse.json({ error: "user_selectable_models must be an array of model ids" }, { status: 400 });
    }
    const unknown = body.user_selectable_models.filter((id) => !isSelectableClaudeModel(id));
    if (unknown.length) {
      return NextResponse.json({ error: `Unknown model(s): ${unknown.join(", ")}` }, { status: 400 });
    }
    // Dedupe so the stored array can't accumulate repeats from a retry.
    const next = [...new Set(body.user_selectable_models as string[])];

    const { error } = await supabase
      .from("product_config")
      .update({ user_selectable_claude_models: next })
      .eq("service", "_global");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    invalidateDefaultClaudeModelCache();
    return NextResponse.json({ ok: true, user_selectable_models: next });
  }

  // Model update path. Checked before routing so a model-only body isn't
  // rejected by the routing validation below.
  if (body.model !== undefined) {
    if (!isSelectableClaudeModel(body.model)) {
      return NextResponse.json(
        { error: `Unknown model: ${body.model}. Valid: ${CLAUDE_MODELS.map((m) => m.id).join(", ")}` },
        { status: 400 },
      );
    }

    const { error } = await supabase
      .from("product_config")
      .update({ default_claude_model: body.model })
      .eq("service", "_global");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    invalidateDefaultClaudeModelCache();
    return NextResponse.json({ ok: true, model: body.model });
  }

  // GPT model update path — which model the gpt provider runs on.
  if (body.gpt_model !== undefined) {
    if (!isSelectableGptModel(body.gpt_model)) {
      return NextResponse.json(
        { error: `Unknown GPT model: ${body.gpt_model}. Valid: ${GPT_MODELS.map((m) => m.id).join(", ")}` },
        { status: 400 },
      );
    }

    const { error } = await supabase
      .from("product_config")
      .update({ default_gpt_model: body.gpt_model })
      .eq("service", "_global");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    invalidatePromptProviderCache();
    return NextResponse.json({ ok: true, gpt_model: body.gpt_model });
  }

  // Gemini model update path — which model the gemini provider runs on.
  if (body.gemini_model !== undefined) {
    if (!isSelectableGeminiModel(body.gemini_model)) {
      return NextResponse.json(
        { error: `Unknown Gemini model: ${body.gemini_model}. Valid: ${GEMINI_MODELS.map((m) => m.id).join(", ")}` },
        { status: 400 },
      );
    }

    const { error } = await supabase
      .from("product_config")
      .update({ default_gemini_model: body.gemini_model })
      .eq("service", "_global");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    invalidatePromptProviderCache();
    return NextResponse.json({ ok: true, gemini_model: body.gemini_model });
  }

  // Per-step provider path. Checked before the per-step routing branch below,
  // which would otherwise reject a { step, provider } body for having no
  // routing field.
  if (body.provider !== undefined) {
    if (invalidTarget !== undefined || targets.length === 0) {
      return NextResponse.json({ error: `Unknown step: ${invalidTarget ?? body.step}. Valid: ${WORKFLOW_STEPS.join(", ")}` }, { status: 400 });
    }
    const claudeOnly = targets.find((s) => !PROVIDER_STEPS.has(s));
    if (claudeOnly) {
      return NextResponse.json(
        { error: `${claudeOnly} is Claude-only. Provider is selectable for: ${[...PROVIDER_STEPS].join(", ")}` },
        { status: 400 },
      );
    }
    if (!isPromptProvider(body.provider)) {
      return NextResponse.json({ error: "provider must be 'claude' or 'gpt'" }, { status: 400 });
    }

    const { data: cur, error: readErr } = await supabase
      .from("product_config")
      .select("prompt_provider_per_step")
      .eq("service", "_global")
      .single();
    if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });

    const next = sanitiseProviderPerStep(cur?.prompt_provider_per_step);
    for (const target of targets) {
      // Claude is the default, so store it as an absent key rather than an
      // explicit value — keeps the map to just the steps that deviate.
      if (body.provider === "claude") delete next[target];
      else next[target] = body.provider;
    }

    const { error } = await supabase
      .from("product_config")
      .update({ prompt_provider_per_step: next })
      .eq("service", "_global");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    invalidatePromptProviderCache();
    return NextResponse.json({ ok: true, provider_per_step: next });
  }

  // Per-step update path.
  if (targets.length > 0 || body.step !== undefined) {
    if (invalidTarget !== undefined || targets.length === 0) {
      return NextResponse.json({ error: `Unknown step: ${invalidTarget ?? body.step}. Valid: ${WORKFLOW_STEPS.join(", ")}` }, { status: 400 });
    }
    if (body.routing !== null && !isAnthropicRouting(body.routing)) {
      return NextResponse.json({ error: "routing must be one of: client_kie, heclus_kie, heclus_direct, or null to inherit" }, { status: 400 });
    }

    const { data: cur, error: readErr } = await supabase
      .from("product_config")
      .select("anthropic_routing_per_step")
      .eq("service", "_global")
      .single();
    if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });

    const next = sanitisePerStep(cur?.anthropic_routing_per_step);
    for (const target of targets) {
      if (body.routing === null) {
        delete next[target];
      } else {
        next[target] = body.routing as AnthropicRouting;
      }
    }

    const { error } = await supabase
      .from("product_config")
      .update({ anthropic_routing_per_step: next })
      .eq("service", "_global");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true, per_step: next });
  }

  // Global-default update path (backwards compatible with the prior shape).
  if (!isAnthropicRouting(body.routing)) {
    return NextResponse.json({ error: "routing must be one of: client_kie, heclus_kie, heclus_direct" }, { status: 400 });
  }

  const { error } = await supabase
    .from("product_config")
    .update({ anthropic_routing: body.routing })
    .eq("service", "_global");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, routing: body.routing });
}
