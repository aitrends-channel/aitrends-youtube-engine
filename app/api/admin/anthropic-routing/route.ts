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
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

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

  // Read through the shared resolver so the tab shows exactly what
  // generation will use, including the allowlist filtering.
  const modelConfig = await getClaudeModelConfig();

  return NextResponse.json({
    routing: data?.anthropic_routing ?? "client_kie",
    per_step: sanitisePerStep(data?.anthropic_routing_per_step),
    steps: WORKFLOW_STEPS,
    model: modelConfig.default,
    models: CLAUDE_MODELS,
    model_fallback: CLAUDE_MODEL_FALLBACK,
    user_selectable_models: modelConfig.userSelectable,
    user_choice_steps: [...USER_CHOICE_STEPS],
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
    model?: string;
    user_selectable_models?: unknown;
  };

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

  // Per-step update path.
  if (body.step !== undefined) {
    if (!isWorkflowStep(body.step)) {
      return NextResponse.json({ error: `Unknown step: ${body.step}. Valid: ${WORKFLOW_STEPS.join(", ")}` }, { status: 400 });
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
    if (body.routing === null) {
      delete next[body.step];
    } else {
      next[body.step] = body.routing as AnthropicRouting;
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
