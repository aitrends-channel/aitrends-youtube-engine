import "server-only";
import { supabase } from "@/lib/supabase/client";
import { isAdminUser } from "@/lib/admin";
import { checkElevenLabs, checkKie, type ElevenLabsCheck, type KieCheck } from "@/lib/key-check";
import { getQuotaConfig, capFromConfig } from "@/lib/quota-config";

// The facts a support ticket is diagnosed from. Gathered deterministically, in
// a fixed shape, before any model sees the ticket text.
//
// Two rules hold this together:
//
//   1. Nothing here is chosen by the ticket. A ticket body is text a stranger
//      wrote, so it never selects a table, a filter, or an account. It is
//      evidence to explain, not instructions to follow.
//   2. No key material leaves this module. Keys are reported as shape and
//      verdict — 15 characters, prefix hxkj_v, KIE says 401 — which is what
//      every real diagnosis has needed. The values themselves are never
//      included, so a diagnosis can be logged or pasted into a reply safely.
//
// It reads. It never writes.

export interface KeyEvidence {
  stored: boolean;
  length: number;
  /** First six characters, enough to recognise a format without exposing one. */
  prefix: string;
  /** Live verdict from the provider. Absent for Anthropic, which we don't probe. */
  check?: KieCheck | ElevenLabsCheck;
  /** How this length compares to what working accounts have. */
  lengthNote?: string;
}

export interface ProjectEvidence {
  id: string;
  channel: string | null;
  topic: string | null;
  state: number;
  assemblyStatus: string | null;
  promptsLastError: string | null;
  autoPilotError: string | null;
  createdAt: string;
}

export interface DiagnosisEvidence {
  /** The ticket or email as received. Data, never instructions. */
  report: { subject: string | null; body: string; from: string; receivedAt: string | null };
  account:
    | { found: false; email: string }
    | {
        found: true;
        userId: string;
        email: string;
        plan: string;
        paid: boolean;
        isAdmin: boolean;
        createdAt: string;
        planExpiresAt: string | null;
        planExpired: boolean;
      };
  keys?: { kie: KeyEvidence; elevenlabs: KeyEvidence; anthropic: KeyEvidence };
  /** Whether the account's writing steps run on its own Anthropic key. */
  anthropicDirectEnabled?: boolean;
  projects?: ProjectEvidence[];
  /** Raw provider units consumed in the last 30 days, by provider and kind. */
  costs30d?: { key: string; units: number }[];
  lastCostActivity?: string | null;
  /** Heclus-funded perks: consumed this month against the plan's allowance. */
  freeUsage?: { kind: string; used: number; quota: number | null }[];
  /** Anything we tried to read and couldn't. Named so a gap never reads as a zero. */
  gaps: string[];
}

/** Lengths of working keys, so an outlier is visible without a second query. */
const EXPECTED_KEY_LENGTH: Record<string, number> = {
  kie_api_key: 32,
  elevenlabs_api_key: 51,
};

function keyEvidence(field: string, raw: unknown): KeyEvidence {
  const value = typeof raw === "string" ? raw.trim() : "";
  const expected = EXPECTED_KEY_LENGTH[field];
  return {
    stored: value.length > 0,
    length: value.length,
    prefix: value.slice(0, 6),
    ...(value.length > 0 && expected && value.length !== expected
      ? { lengthNote: `working accounts store ${expected} characters` }
      : {}),
  };
}

export async function gatherEvidence(report: DiagnosisEvidence["report"]): Promise<DiagnosisEvidence> {
  const gaps: string[] = [];
  const email = report.from.trim().toLowerCase();

  // Match the reporter to an account by email. An unmatched address is a real
  // outcome, not an error: people write in from addresses they never signed up
  // with, and a diagnosis that says so beats one that invents an account.
  const { data: userList, error: userErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (userErr) gaps.push(`could not list accounts: ${userErr.message}`);
  const account = (userList?.users ?? []).find((u) => (u.email ?? "").toLowerCase() === email);

  if (!account) {
    return {
      report,
      account: { found: false, email },
      gaps: [...gaps, "no account matches this email address, so account-level evidence is unavailable"],
    };
  }

  const meta = (account.app_metadata ?? {}) as Record<string, unknown>;
  const planExpiresAt = typeof meta.plan_expires_at === "string" ? meta.plan_expires_at : null;

  const evidence: DiagnosisEvidence = {
    report,
    account: {
      found: true,
      userId: account.id,
      email: account.email ?? email,
      plan: (typeof meta.plan === "string" ? meta.plan : "").trim() || "free",
      paid: meta.paid === true,
      isAdmin: isAdminUser(account),
      createdAt: account.created_at,
      planExpiresAt,
      planExpired: planExpiresAt !== null && new Date(planExpiresAt).getTime() < Date.now(),
    },
    gaps,
  };

  // Keys. account_settings directly, never getSettings: that helper resolves
  // to the platform key when the account has none, which would report our
  // credential's health as theirs.
  const { data: settings, error: settingsErr } = await supabase
    .from("account_settings")
    .select("kie_api_key, elevenlabs_api_key, anthropic_api_key, anthropic_direct_enabled")
    .eq("user_id", account.id)
    .maybeSingle();
  if (settingsErr) {
    gaps.push(`could not read stored keys: ${settingsErr.message}`);
  } else {
    const row = (settings ?? {}) as Record<string, unknown>;
    const kie = keyEvidence("kie_api_key", row.kie_api_key);
    const elevenlabs = keyEvidence("elevenlabs_api_key", row.elevenlabs_api_key);
    const anthropic = keyEvidence("anthropic_api_key", row.anthropic_api_key);

    // Ask the providers. This is the step that turns "the key looks odd" into
    // "KIE rejects it", and it is the same call the user's own dashboard makes.
    const [kieCheck, elCheck] = await Promise.all([
      kie.stored ? checkKie(String(row.kie_api_key).trim()) : Promise.resolve(undefined),
      elevenlabs.stored ? checkElevenLabs(String(row.elevenlabs_api_key).trim()) : Promise.resolve(undefined),
    ]);
    evidence.keys = {
      kie: { ...kie, ...(kieCheck ? { check: kieCheck } : {}) },
      elevenlabs: { ...elevenlabs, ...(elCheck ? { check: elCheck } : {}) },
      anthropic,
    };
    evidence.anthropicDirectEnabled = row.anthropic_direct_enabled === true;
  }

  // Recent projects, with whatever error the workflow last recorded. This is
  // where a failing step names itself.
  const { data: projects, error: projErr } = await supabase
    .from("projects")
    .select("id, channel_name, selected_topic, current_state, assembly_status, prompts_last_error, auto_pilot_error, created_at")
    .eq("user_id", account.id)
    .order("created_at", { ascending: false })
    .limit(5);
  if (projErr) {
    gaps.push(`could not read recent videos: ${projErr.message}`);
  } else {
    evidence.projects = (projects ?? []).map((p) => {
      const r = p as Record<string, unknown>;
      return {
        id: String(r.id),
        channel: (r.channel_name as string | null) ?? null,
        topic: (r.selected_topic as string | null) ?? null,
        state: Number(r.current_state ?? 0),
        assemblyStatus: (r.assembly_status as string | null) ?? null,
        promptsLastError: (r.prompts_last_error as string | null) ?? null,
        autoPilotError: (r.auto_pilot_error as string | null) ?? null,
        createdAt: String(r.created_at),
      };
    });
  }

  // Consumption over the last 30 days, so "nothing is working" can be checked
  // against whether anything ran at all.
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { data: costs, error: costErr } = await supabase
    .from("project_costs")
    .select("provider, unit_kind, units, created_at")
    .eq("user_id", account.id)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(1000);
  if (costErr) {
    gaps.push(`could not read usage: ${costErr.message}`);
  } else {
    const totals = new Map<string, number>();
    for (const row of (costs ?? []) as Record<string, unknown>[]) {
      const key = `${row.provider}/${row.unit_kind}`;
      totals.set(key, (totals.get(key) ?? 0) + (Number(row.units) || 0));
    }
    evidence.costs30d = [...totals.entries()].map(([key, units]) => ({ key, units }));
    evidence.lastCostActivity = ((costs ?? [])[0] as Record<string, unknown> | undefined)?.created_at as string | null ?? null;
  }

  // Perk consumption against the allowance, for "my voiceover stopped working"
  // on an account that has spent its free characters.
  const monthStart = new Date().toISOString().slice(0, 8) + "01";
  const { data: free, error: freeErr } = await supabase
    .from("free_usage")
    .select("kind, count, day")
    .eq("user_id", account.id)
    .gte("day", monthStart);
  if (freeErr) {
    gaps.push(`could not read free-resource usage: ${freeErr.message}`);
  } else {
    const used = new Map<string, number>();
    for (const row of (free ?? []) as Record<string, unknown>[]) {
      const kind = String(row.kind);
      used.set(kind, (used.get(kind) ?? 0) + (Number(row.count) || 0));
    }
    const quotaConfig = await getQuotaConfig();
    const plan = evidence.account.found ? evidence.account.plan : "";
    const admin = evidence.account.found ? evidence.account.isAdmin : false;
    evidence.freeUsage = [...used.entries()].map(([kind, amount]) => ({
      kind,
      used: amount,
      quota: kind === "ai33_tts_chars" ? capFromConfig(quotaConfig, "ai33_tts_chars", plan, admin) : null,
    }));
  }

  return evidence;
}
