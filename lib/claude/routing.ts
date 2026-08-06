import { supabase } from "@/lib/supabase/client";
import { getSettings } from "@/lib/settings";

/**
 * Where Claude calls get routed. Set globally by admin in Config → Anthropic.
 *
 *   client_kie    – use the end-user's KIE API key (default, current behavior)
 *   client_direct – call Anthropic directly with the END USER's own Anthropic
 *                   key (account_settings.anthropic_api_key). Not selectable as
 *                   a global default: it is what client_kie becomes for a
 *                   client who opted in, per user. See getRoutingForUser.
 *   heclus_kie    – use Heclus's KIE key (product_config service='heclus_kie_api_key')
 *   heclus_direct – call Anthropic directly with Heclus's Anthropic API key
 *                   (product_config service='anthropic_api_key'), bypassing KIE
 */
export type AnthropicRouting = "client_kie" | "client_direct" | "heclus_kie" | "heclus_direct";

/** Whose money the call spends. Drives two decisions elsewhere: whether a
 *  user's own model pick is honoured (lib/claude/models.ts) and which ledger
 *  the cost lands in (lib/costs.ts). */
export function isClientPaid(routing: AnthropicRouting): boolean {
  return routing === "client_kie" || routing === "client_direct";
}

/** True when the call goes straight to api.anthropic.com and is billed in
 *  tokens, rather than through KIE and billed in credits. */
export function isDirectRouting(routing: AnthropicRouting): boolean {
  return routing === "client_direct" || routing === "heclus_direct";
}

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

// client_direct is deliberately NOT accepted here. It is a per-user upgrade of
// client_kie, not something an admin can set globally — configuring it for
// everyone would break every client who hasn't supplied an Anthropic key.
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
 * The routing that actually applies to one user's call. Same as
 * getAnthropicRouting, except a client who has supplied their own Anthropic key
 * and switched it on runs client_direct instead of client_kie.
 *
 * Scoped to client_kie on purpose: that is the only routing where the client's
 * key is already what pays, so swapping which of THEIR keys is used changes
 * nothing about who is billed. When an admin has moved a step to heclus_kie or
 * heclus_direct, Heclus is deliberately covering it — quietly spending the
 * client's Anthropic key there would override that decision.
 */
export async function getRoutingForUser(userId: string, step?: WorkflowStep): Promise<AnthropicRouting> {
  const routing = await getAnthropicRouting(step);
  if (routing !== "client_kie") return routing;
  try {
    const { anthropic_api_key, anthropic_direct_enabled } = await getSettings(userId);
    if (anthropic_direct_enabled && anthropic_api_key) return "client_direct";
  } catch {
    // Settings unreadable (or migration 117 not applied) — stay on KIE rather
    // than failing the call over an optional preference.
  }
  return routing;
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
