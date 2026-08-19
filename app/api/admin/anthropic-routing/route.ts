import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";
import { WORKFLOW_STEPS, isWorkflowStep, type AnthropicRouting, type WorkflowStep } from "@/lib/claude/routing";
import {
  CLAUDE_MODELS,
  CLAUDE_MODEL_FALLBACK,
  USER_CHOICE_STEPS,
  claudeRateFor,
  getClaudeModelConfig,
  invalidateDefaultClaudeModelCache,
  isSelectableClaudeModel,
} from "@/lib/claude/models";
import {
  MAX_VISUAL_ANALYSIS_IMAGES,
  MIN_VISUAL_ANALYSIS_IMAGES,
  VISION_MODEL_IDS,
  getVisionConfig,
  invalidateVisionConfigCache,
  isSelectableVisionModel,
  visionModels,
} from "@/lib/claude/vision";
import {
  GEMINI_MODELS,
  GPT_MODELS,
  PROVIDER_STEPS,
  getPromptProviderConfig,
  invalidatePromptProviderCache,
  isPromptProvider,
  isSelectableGeminiModel,
  isSelectableGptModel,
  modelBelongsTo,
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

  const vision = await getVisionConfig();
  const visionCost = await visionSpend14d();

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
    // Per-step model overrides. Absent key means the step uses the provider
    // default below, which is what every step did before this existed.
    model_per_step: providerConfig.modelPerStep,
    provider_steps: [...PROVIDER_STEPS],
    gpt_model: providerConfig.gptModel,
    gpt_models: GPT_MODELS,
    gemini_model: providerConfig.geminiModel,
    gemini_models: GEMINI_MODELS,
    vision_model: vision.model,
    vision_models: visionModels(),
    visual_analysis_max_images: vision.maxImages,
    visual_analysis_image_bounds: { min: MIN_VISUAL_ANALYSIS_IMAGES, max: MAX_VISUAL_ANALYSIS_IMAGES },
    vision_cost_14d: visionCost,
  });
}

/**
 * What the vision step actually cost over the last 14 days, plus what the same
 * traffic would cost on each selectable model. Measured tokens, not an
 * estimate: the admin picking a model can see the trade rather than guess it.
 *
 * Reads project_costs for the visuals step. Rows carry the model that served
 * them, so the "actual" figure prices each row at its own rate even if the
 * model changed mid-window.
 */
async function visionSpend14d() {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const { data, error } = await supabase
    .from("project_costs")
    .select("model, unit_kind, units")
    .eq("step", "visuals")
    .eq("provider", "anthropic")
    .gte("created_at", since);
  if (error || !data) return null;

  let actual = 0;
  let inTokens = 0;
  let outTokens = 0;
  for (const row of data as Array<{ model: string | null; unit_kind: string; units: number | null }>) {
    const units = Number(row.units ?? 0);
    const rate = claudeRateFor(row.model ?? "") ?? { in: 0, out: 0 };
    if (row.unit_kind === "claude_tokens_in") { inTokens += units; actual += (units / 1e6) * rate.in; }
    else if (row.unit_kind === "claude_tokens_out") { outTokens += units; actual += (units / 1e6) * rate.out; }
  }

  // Same token volume repriced per model, so the picker can show the delta.
  const byModel: Record<string, number> = {};
  for (const id of VISION_MODEL_IDS) {
    const rate = claudeRateFor(id);
    if (rate) byModel[id] = +((inTokens / 1e6) * rate.in + (outTokens / 1e6) * rate.out).toFixed(2);
  }

  return {
    days: 14,
    calls: data.filter((r) => r.unit_kind === "claude_tokens_in").length,
    input_tokens: inTokens,
    output_tokens: outTokens,
    actual_usd: +actual.toFixed(2),
    by_model_usd: byModel,
  };
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
    vision_model?: string;
    visual_analysis_max_images?: unknown;
  };

  // Vision model — the image-reading steps (visual analysis, prompts-from-image).
  // Separate from default_claude_model on purpose: those steps pay per image and
  // the right trade there is not the same as for the text steps.
  if (body.vision_model !== undefined) {
    if (!isSelectableVisionModel(body.vision_model)) {
      return NextResponse.json(
        { error: `Unknown vision model: ${body.vision_model}. Valid: ${VISION_MODEL_IDS.join(", ")}` },
        { status: 400 },
      );
    }
    const { error } = await supabase
      .from("product_config")
      .update({ vision_model: body.vision_model })
      .eq("service", "_global");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    invalidateVisionConfigCache();
    console.log(`[admin] ${user.email} set vision model to ${body.vision_model}`);
    return NextResponse.json({ ok: true, vision_model: body.vision_model });
  }

  // How many frames the visual-analysis step sends per call.
  if (body.visual_analysis_max_images !== undefined) {
    const n = Number(body.visual_analysis_max_images);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < MIN_VISUAL_ANALYSIS_IMAGES || n > MAX_VISUAL_ANALYSIS_IMAGES) {
      return NextResponse.json(
        { error: `Images must be a whole number between ${MIN_VISUAL_ANALYSIS_IMAGES} and ${MAX_VISUAL_ANALYSIS_IMAGES}.` },
        { status: 400 },
      );
    }
    const { error } = await supabase
      .from("product_config")
      .update({ visual_analysis_max_images: n })
      .eq("service", "_global");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    invalidateVisionConfigCache();
    console.log(`[admin] ${user.email} set visual-analysis images to ${n}`);
    return NextResponse.json({ ok: true, visual_analysis_max_images: n });
  }

  // The admin UI groups the three prompt sub-steps (beats, image prompts,
  // video prompts) into one card, so a single click has to land on both
  // underlying slugs at once. `steps` applies the change to all of them in
  // one read-modify-write, which keeps the group from ever half-saving into a
  // mixed state. `step` (singular) stays for the one-step cards.
  const rawTargets = Array.isArray(body.steps) ? body.steps : body.step !== undefined ? [body.step] : [];
  const invalidTarget = rawTargets.find((s) => !isWorkflowStep(s));
  const targets = rawTargets.filter(isWorkflowStep);


  // Writes a model override onto specific steps instead of the global default.
  // Stored in prompt_provider_per_step as { provider, model }, alongside the
  // bare-string entries the provider-only path writes: one column, two shapes,
  // no migration. The step has to already be on this provider — a gpt model on
  // a claude step would be dead config that springs to life the day someone
  // switches that step over.
  async function setPerStepModel(provider: PromptProvider, model: string) {
    const { data: cur, error: readErr } = await supabase
      .from("product_config")
      .select("prompt_provider_per_step")
      .eq("service", "_global")
      .single();
    if (readErr) return NextResponse.json({ error: readErr.message }, { status: 500 });

    const raw = (cur?.prompt_provider_per_step ?? {}) as Record<string, unknown>;
    const next: Record<string, unknown> = { ...raw };
    for (const target of targets) {
      const entry = next[target];
      const currentProvider = typeof entry === "string"
        ? entry
        : (entry as { provider?: unknown } | undefined)?.provider;
      if (currentProvider !== provider) {
        return NextResponse.json(
          { error: `${target} is not running on ${provider}. Switch its provider first.` },
          { status: 400 },
        );
      }
      next[target] = { provider, model };
    }

    const { error } = await supabase
      .from("product_config")
      .update({ prompt_provider_per_step: next })
      .eq("service", "_global");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    invalidatePromptProviderCache();
    return NextResponse.json({ ok: true, model_per_step: next });
  }

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

    // With steps named, this is a per-step override. Without, it is the default
    // every gpt step falls back to. Before this split, the admin UI's per-step
    // model picker wrote the global column, so changing the model on one step
    // silently changed it for all of them.
    if (targets.length > 0) return setPerStepModel("gpt", body.gpt_model);

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

    if (targets.length > 0) return setPerStepModel("gemini", body.gemini_model);

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

    const rawCur = (cur?.prompt_provider_per_step ?? {}) as Record<string, unknown>;
    const next = sanitiseProviderPerStep(cur?.prompt_provider_per_step) as Record<string, unknown>;
    for (const target of targets) {
      // Claude is the default, so store it as an absent key rather than an
      // explicit value — keeps the map to just the steps that deviate.
      if (body.provider === "claude") { delete next[target]; continue; }

      // Keep a model override across a provider save, but only when it still
      // belongs to the provider being set. Re-selecting the provider a step is
      // already on should not quietly reset its model, and switching gpt to
      // gemini must not carry a gpt id across into a rejected request.
      const prev = rawCur[target];
      const prevModel = typeof prev === "object" && prev !== null
        ? (prev as { model?: unknown }).model
        : undefined;
      next[target] = typeof prevModel === "string" && modelBelongsTo(body.provider, prevModel)
        ? { provider: body.provider, model: prevModel }
        : body.provider;
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
