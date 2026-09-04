export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getSettings, invalidateSettingsCache } from "@/lib/settings";
import { getRequiredUser } from "@/lib/supabase/auth";
import { checkAnthropic, checkElevenLabs, checkKie, keyRejectionMessage } from "@/lib/key-check";
import { prefixTooLongMessage } from "@/lib/prefix-limit";
import type { User } from "@supabase/supabase-js";

function mask(value: string): string {
  if (!value) return "";
  if (value.length <= 4) return "****";
  return "•".repeat(Math.min(value.length - 4, 24)) + value.slice(-4);
}

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const s = await getSettings(user.id);

    // Masks are built from what this ACCOUNT stores, not from getSettings,
    // which resolves kie_api_key and elevenlabs_api_key to the platform env
    // key when the user has none. Reading through it meant two things: every
    // account without its own key saw the last four characters of ours, and
    // removing a key left the section still showing "Configured", a Current
    // row and a Remove button, because the fallback kept the mask non-empty.
    const { data: own } = await supabase
      .from("account_settings")
      .select("kie_api_key, elevenlabs_api_key, anthropic_api_key")
      .eq("user_id", user.id)
      .maybeSingle();
    const stored = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const ownKie        = stored((own as Record<string, unknown> | null)?.kie_api_key);
    const ownElevenlabs = stored((own as Record<string, unknown> | null)?.elevenlabs_api_key);
    const ownAnthropic  = stored((own as Record<string, unknown> | null)?.anthropic_api_key);

    // A user who only ever set a prefix in a project's Prompts step has no
    // account default, so the Setup field would open blank and look like
    // they never wrote one. Surface their most recent project-level prefix
    // as a suggestion the Setup panel can prefill — saving it is what
    // actually promotes it to the account default.
    let character_consistency_suggestion = "";
    if (!s.character_consistency_text.trim()) {
      const { data: recent } = await supabase
        .from("projects")
        .select("character_consistency_text")
        .eq("user_id", user.id)
        .not("character_consistency_text", "is", null)
        .neq("character_consistency_text", "")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      character_consistency_suggestion = ((recent?.character_consistency_text as string | null) ?? "").trim();
    }

    return NextResponse.json({
      kie_api_key: mask(ownKie),
      elevenlabs_api_key: mask(ownElevenlabs),
      anthropic_api_key: mask(ownAnthropic),
      // Whether the key is actually in use. The toggle needs the real boolean,
      // and the UI needs to know a key exists to decide if it can be turned on.
      anthropic_direct_enabled: s.anthropic_direct_enabled,
      has_anthropic_api_key: !!ownAnthropic,
      // Not a secret — returned in full so the prompts step can show the
      // inherited account default as a placeholder / prefill.
      character_consistency_text: s.character_consistency_text,
      // Empty whenever an account default already exists.
      character_consistency_suggestion,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to load settings" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const body = await req.json() as Partial<{
      kie_api_key: string;
      elevenlabs_api_key: string;
      character_consistency_text: string;
      anthropic_api_key: string;
      anthropic_direct_enabled: boolean;
      remove_anthropic_api_key: boolean;
      remove_kie_api_key: boolean;
      remove_elevenlabs_api_key: boolean;
    }>;

    const update: Record<string, string | boolean | null> = {};
    if (body.kie_api_key?.trim()) update.kie_api_key = body.kie_api_key.trim();
    if (body.elevenlabs_api_key?.trim()) update.elevenlabs_api_key = body.elevenlabs_api_key.trim();
    if (body.anthropic_api_key?.trim()) update.anthropic_api_key = body.anthropic_api_key.trim();
    // Deletion is an explicit flag, never an empty string: the Setup form
    // posts every field, so treating "" as "clear" would wipe a saved key
    // any time the user saved without re-typing it. Turns the preference off
    // in the same write — leaving it on with no key would fail every call.
    if (body.remove_anthropic_api_key) {
      update.anthropic_api_key = null;
      update.anthropic_direct_enabled = false;
    } else if (typeof body.anthropic_direct_enabled === "boolean") {
      update.anthropic_direct_enabled = body.anthropic_direct_enabled;
    }
    // Same explicit-flag rule for the other two. Without a way to clear them,
    // a key that a provider rejects is a dead end: getSettings prefers any
    // stored value over the platform fallback, so overwriting was the only
    // escape and there was none at all for someone who no longer has a
    // working key to paste.
    if (body.remove_kie_api_key) update.kie_api_key = null;
    if (body.remove_elevenlabs_api_key) update.elevenlabs_api_key = null;

    // Check a pasted key with its provider before storing it. A credential
    // that cannot authenticate is worse than none: it shadows the platform
    // fallback and fails at generation time, hours after the save that
    // reported success. Only a definitive rejection blocks the write, so an
    // upstream outage can still be saved through.
    const rejections = (await Promise.all([
      typeof update.kie_api_key === "string"
        ? checkKie(update.kie_api_key).then((c) => keyRejectionMessage("kie", c))
        : null,
      typeof update.elevenlabs_api_key === "string"
        ? checkElevenLabs(update.elevenlabs_api_key).then((c) => keyRejectionMessage("elevenlabs", c))
        : null,
      // Checked like the other two now. It was the one field that took
      // anything: two production accounts hold a value here that Anthropic
      // has never seen, one of them their own KIE key.
      typeof update.anthropic_api_key === "string"
        ? checkAnthropic(update.anthropic_api_key).then((c) => keyRejectionMessage("anthropic", c))
        : null,
    ])).filter((m): m is string => !!m);
    if (rejections.length > 0) {
      return NextResponse.json({ error: rejections.join(" ") }, { status: 400 });
    }
    // Consistency text is free text, not a secret — persist it whenever
    // the key is present (unlike the API keys above, an empty string is a
    // valid value here: it clears a previously-set default).
    if (body.character_consistency_text !== undefined) {
      const tooLong = prefixTooLongMessage(body.character_consistency_text);
      if (tooLong) return NextResponse.json({ error: tooLong }, { status: 400 });
      update.character_consistency_text = body.character_consistency_text;
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: "No keys provided" }, { status: 400 });
    }

    // Switching direct billing on without a key to bill would fail every
    // Claude call, so refuse it here rather than at generation time.
    if (update.anthropic_direct_enabled === true && !update.anthropic_api_key) {
      const existing = await getSettings(user.id);
      if (!existing.anthropic_api_key) {
        return NextResponse.json(
          { error: "Add your Anthropic API key before switching direct billing on." },
          { status: 400 },
        );
      }
    }

    // Explicit onConflict so the upsert always merges into the
    // existing row instead of leaning on supabase-js's default
    // primary-key inference. ignoreDuplicates: false ensures the
    // EXCLUDED.<col> values overwrite the existing ones on UPDATE.
    const { data: written, error } = await supabase
      .from("account_settings")
      .upsert(
        { user_id: user.id, ...update },
        { onConflict: "user_id", ignoreDuplicates: false },
      )
      .select("user_id, kie_api_key, elevenlabs_api_key")
      .single();

    if (error) throw new Error(error.message);

    invalidateSettingsCache(user.id);

    // Log what was just persisted (key lengths only — never the key
    // itself) so a "I saved it but it didn't stick" report is
    // diagnosable from Vercel logs without exposing secrets.
    console.log(
      `[settings] user=${user.id} update=${Object.keys(update).join(",")} ` +
        `persisted: kie_api_key.len=${written?.kie_api_key?.length ?? 0} ` +
        `elevenlabs_api_key.len=${written?.elevenlabs_api_key?.length ?? 0}`,
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to save settings" }, { status: 500 });
  }
}
