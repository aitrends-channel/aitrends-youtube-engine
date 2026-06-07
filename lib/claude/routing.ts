import { supabase } from "@/lib/supabase/client";

/**
 * Where Claude calls get routed. Set globally by admin in Config → Anthropic.
 *
 *   client_kie    – use the end-user's KIE API key (default, current behavior)
 *   heclus_kie    – use Heclus's KIE key (product_config service='heclus_kie_api_key')
 *   heclus_direct – call Anthropic directly with Heclus's Anthropic API key
 *                   (product_config service='anthropic_api_key'), bypassing KIE
 */
export type AnthropicRouting = "client_kie" | "heclus_kie" | "heclus_direct";

/**
 * Workflow step slugs accepted by the per-step routing override. Kept in
 * sync with the JSONB keys written by the admin UI / API and with the
 * `step` argument each workflow route passes to getAnthropicClient.
 * Adding a new step here is a 3-touch change: this union, the admin
 * panel's STEP_LIST, and the calling route.
 */
export const WORKFLOW_STEPS = [
  "analyze",
  "ideas",
  "script",
  "visual_analysis",
  "image_prompts",
  "video_prompts",
  "thumbnails",
] as const;
export type WorkflowStep = (typeof WORKFLOW_STEPS)[number];

export function isWorkflowStep(v: unknown): v is WorkflowStep {
  return typeof v === "string" && (WORKFLOW_STEPS as readonly string[]).includes(v);
}

function normaliseRouting(v: unknown): AnthropicRouting | null {
  if (v === "client_kie" || v === "heclus_kie" || v === "heclus_direct") return v;
  return null;
}

/**
 * Resolves the routing for a given workflow step. Lookup order:
 *   1. Per-step override map (anthropic_routing_per_step JSONB), if the
 *      step has an explicit value.
 *   2. Global default (anthropic_routing column).
 *   3. Hardcoded fallback: "client_kie" (the pre-feature behaviour).
 *
 * Passing no step returns the global default — used by the admin UI to
 * display "what would happen with no override".
 */
export async function getAnthropicRouting(step?: WorkflowStep): Promise<AnthropicRouting> {
  const { data } = await supabase
    .from("product_config")
    .select("anthropic_routing, anthropic_routing_per_step")
    .eq("service", "_global")
    .single();

  if (step) {
    const perStep = (data?.anthropic_routing_per_step ?? null) as Record<string, unknown> | null;
    const override = normaliseRouting(perStep?.[step]);
    if (override) return override;
  }

  return normaliseRouting(data?.anthropic_routing) ?? "client_kie";
}

/**
 * Returns the raw per-step override map without applying any fallback.
 * Used by the admin UI to render which steps are explicitly overridden
 * vs. inheriting from General. An unset key means "inherit".
 */
export async function getAnthropicRoutingPerStep(): Promise<Partial<Record<WorkflowStep, AnthropicRouting>>> {
  const { data } = await supabase
    .from("product_config")
    .select("anthropic_routing_per_step")
    .eq("service", "_global")
    .single();
  const raw = (data?.anthropic_routing_per_step ?? null) as Record<string, unknown> | null;
  if (!raw) return {};
  const out: Partial<Record<WorkflowStep, AnthropicRouting>> = {};
  for (const step of WORKFLOW_STEPS) {
    const v = normaliseRouting(raw[step]);
    if (v) out[step] = v;
  }
  return out;
}

/** Pulls the currently-active key from a multi-key product_config row.
 *  Mirrors the rotation pattern used by YouTube/Supadata key handlers. */
export async function getActiveProductKey(service: string): Promise<string | null> {
  const { data } = await supabase
    .from("product_config")
    .select("keys, current_index, active")
    .eq("service", service)
    .single();
  if (!data || data.active === false) return null;
  const keys = (data.keys ?? []) as string[];
  if (!keys.length) return null;
  const idx = data.current_index ?? 0;
  return keys[Math.min(idx, keys.length - 1)] ?? null;
}
