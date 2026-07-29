import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { getSettings, invalidateSettingsCache } from "@/lib/settings";
import { CLAUDE_MODELS, TIER_LABELS, getClaudeModelConfig } from "@/lib/claude/models";
import { isProTier } from "@/lib/plans-gating";
import type { User } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";

// The user's own Claude model pick for the prompt steps, shown on /setup.
// The allowlist and the Pro gate are enforced here AND again at generation
// time in resolveModelForUser — this endpoint drives the affordance, it is
// not the security boundary.

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const config = await getClaudeModelConfig();
  const options = CLAUDE_MODELS
    .filter((m) => config.userSelectable.includes(m.id))
    .map((m) => ({ id: m.id, label: m.label, note: m.note, tier: m.tier, tierLabel: TIER_LABELS[m.tier] }));

  let selected = "";
  try {
    selected = (await getSettings(user.id)).claude_model;
  } catch {
    // Fail-soft: the picker just shows "account default" selected.
  }

  return NextResponse.json({
    // Empty options = the admin hasn't opened the feature up; the UI hides
    // the card entirely rather than showing an empty picker.
    options,
    // Cleared if the admin has since removed it from the allowlist, so the
    // UI never shows a pick that generation wouldn't honour.
    selected: options.some((o) => o.id === selected) ? selected : "",
    isPro: isProTier(user),
  });
}

export async function PUT(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const body = await req.json().catch(() => ({})) as { model?: unknown };

  // null / "" clears the pick and returns the user to the account default.
  const raw = body.model;
  const model = raw === null || raw === "" ? null : typeof raw === "string" ? raw : undefined;
  if (model === undefined) {
    return NextResponse.json({ error: "model must be a model id, or null to use the account default" }, { status: 400 });
  }

  if (model !== null) {
    if (!isProTier(user)) {
      return NextResponse.json({ error: "Choosing a model is a Pro plan feature." }, { status: 403 });
    }
    const config = await getClaudeModelConfig();
    if (!config.userSelectable.includes(model)) {
      return NextResponse.json({ error: "That model isn't available to choose." }, { status: 400 });
    }
  }

  // Upsert — the user may not have an account_settings row yet.
  const { error } = await supabase
    .from("account_settings")
    .upsert({ user_id: user.id, claude_model: model }, { onConflict: "user_id" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  invalidateSettingsCache(user.id);
  return NextResponse.json({ ok: true, model });
}
