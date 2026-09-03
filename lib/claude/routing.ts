import { supabase } from "@/lib/supabase/client";
import { getSettings } from "@/lib/settings";
import { getFundingModeById } from "@/lib/funding";

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
 *   heclus_poyo   – call Claude through PoYo's Anthropic-format Messages API on
 *                   Heclus's PoYo key. Set by the media operator switch rather
 *                   than by this card: when an admin moves the chat surface to
 *                   PoYo, a wallet user's Claude work lands here. Billed per
 *                   token like the direct paths, at $4/$20 per Mtok against
 *                   Anthropic's $5/$25.
 */
export type AnthropicRouting = "client_kie" | "client_direct" | "heclus_kie" | "heclus_direct" | "heclus_poyo";

/** Whose money the call spends. Drives two decisions elsewhere: whether a
 *  user's own model pick is honoured (lib/claude/models.ts) and which ledger
 *  the cost lands in (lib/costs.ts). */
export function isClientPaid(routing: AnthropicRouting): boolean {
  return routing === "client_kie" || routing === "client_direct";
}

/** True when the call goes to PoYo rather than KIE or Anthropic. Separate from
 *  isDirectRouting because the provider on the cost row differs even though the
 *  billing unit does not. */
export function isPoyoRouting(routing: AnthropicRouting): boolean {
  return routing === "heclus_poyo";
}

/** True when the call is billed per token rather than through KIE in credits.
 *
 *  heclus_poyo counts. PoYo prices Claude per token the same way Anthropic
 *  does, so the ledger records claude_tokens_* rows; the provider label on
 *  those rows is what distinguishes the two. */
export function isDirectRouting(routing: AnthropicRouting): boolean {
  return routing === "client_direct" || routing === "heclus_direct" || routing === "heclus_poyo";
}

/**
 * Workflow step slugs accepted by the per-step routing override. Kept in
 * sync with the JSONB keys written by the admin UI / API and with the
 * `step` argument each workflow route passes to getAnthropicClient.
 * Adding a new step here is a 3-touch change: this union, the admin
 * panel's STEP_CARDS, and the calling route.
 *
 * `beats` is beat segmentation — the pass that splits a script into visual
 * beats before any prompt is written. It used to ride image_prompts' routing
 * implicitly; it has its own slug so the Prompts card governs it explicitly.
 * A missing key still inherits, so that change is backwards compatible.
 */
export const WORKFLOW_STEPS = [
  "analyze",
  "ideas",
  "script",
  "visual_analysis",
  "beats",
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
/**
 * Whether the media operator switch is the thing deciding this user's routing,
 * and has moved them somewhere GPT cannot follow.
 *
 * The switch governs work Heclus pays for, so it only reaches wallet-funded
 * accounts. That distinction is the whole answer to a question the routing
 * alone cannot answer: heclus_direct arrives two ways, from this switch and
 * from the per-step routing card, and only the first means "the admin moved
 * this surface". Treating both the same took every BYO customer's channel
 * analysis off GPT-through-KIE, which is where they have always run it and
 * where their card says it runs.
 *
 * PoYo and Anthropic both speak the Anthropic Messages API and neither relays
 * GPT or Gemini, so a step configured for one of those runs Claude instead —
 * see getAnthropicClient, which logs when it happens.
 */
export async function operatorForcesClaude(userId: string): Promise<boolean> {
  try {
    if ((await getFundingModeById(userId)) !== "wallet") return false;
    const { getMediaOperator } = await import("@/lib/operators/routing");
    const chatOperator = await getMediaOperator("chat");
    return chatOperator === "poyo" || chatOperator === "anthropic";
  } catch {
    // Unreadable switch or funding mode: the honest answer is no, which leaves
    // the per-step provider exactly as configured.
    return false;
  }
}

export async function getRoutingForUser(userId: string, step?: WorkflowStep): Promise<AnthropicRouting> {
  const routing = await getAnthropicRouting(step);

  // The media operator switch outranks this card for wallet users. An admin who
  // moved the chat surface to PoYo means it for Claude too, and PoYo runs on
  // Heclus's key so only wallet-funded work can go there. Checked before the
  // client_kie branches below, which are all about keys the user supplies.
  //
  // Imported lazily to keep lib/operators/routing out of this module's import
  // cycle: it already imports lib/funding, which imports settings, which
  // reaches back here.
  try {
    if (await getFundingModeById(userId) === "wallet") {
      const { getMediaOperator } = await import("@/lib/operators/routing");
      const chatOperator = await getMediaOperator("chat");
      if (chatOperator === "poyo") return "heclus_poyo";
      if (chatOperator === "anthropic") return "heclus_direct";
    }
  } catch {
    // Unreadable switch or funding mode — fall through to the existing paths,
    // which is exactly the behaviour before the switch existed.
  }

  if (routing !== "client_kie") return routing;
  // A wallet user has no key of their own to spend, so client_kie is not a
  // routing they can run: it would resolve to a KIE key that does not exist and
  // fail the step. Their work goes on Heclus's KIE key and is metered against
  // their credits. Checked before the client_direct upgrade below, which is
  // also about a key they do not have.
  try {
    if (await getFundingModeById(userId) === "wallet") return "heclus_kie";
  } catch {
    // Unreadable funding mode — fall through to the client paths, which is what
    // every account did before the column existed.
  }
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
