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

export async function getAnthropicRouting(): Promise<AnthropicRouting> {
  const { data } = await supabase
    .from("product_config")
    .select("anthropic_routing")
    .eq("service", "_global")
    .single();
  const v = (data?.anthropic_routing ?? null) as string | null;
  if (v === "heclus_kie" || v === "heclus_direct") return v;
  return "client_kie";
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
