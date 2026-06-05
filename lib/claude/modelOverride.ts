import { isAdminEmail } from "@/lib/admin";
import { isAllowedAnthropicModel } from "./models";
import type { User } from "@supabase/supabase-js";

// Server-side guard for the admin "Choose model" picker. Only admin
// callers can override the route's default; everyone else gets the
// hardcoded fallback even if they manage to put a `model` field in
// the request body. The allowlist (isAllowedAnthropicModel) prevents
// arbitrary string values from reaching the SDK.
export function resolveAnthropicModel(
  user: User,
  override: string | undefined | null,
  fallback: string
): string {
  if (!isAdminEmail(user.email)) return fallback;
  if (!override) return fallback;
  if (!isAllowedAnthropicModel(override)) return fallback;
  return override;
}
