import { supabase } from "@/lib/supabase/client";
import { type FreeUsageKind } from "@/lib/freeUsage";

// Free/perk allowances, allocated per plan. Stored on
// product_config.free_quotas (migration 104), editable in the admin
// dashboard under Config → Quotas.
//
// The ai33 env baseline lives here rather than in lib/ai33/tts.ts (which
// re-exports it) to keep the dependency one-way. Both directions would
// mean whichever module loaded first evaluated QUOTA_DEFAULTS against an
// uninitialized const and threw.
export const AI33_TTS_CAP_STARTER = Number(process.env.AI33_TTS_CAP_STARTER ?? 100_000);
export const AI33_TTS_CAP_PRO = Number(process.env.AI33_TTS_CAP_PRO ?? 200_000);

/** What ai33 bills us per 1M characters, in USD — powers the "costs us
 *  ≈$X/user/month" figure on the quota row. Env-only and unset by default:
 *  a guessed rate on an admin cost readout is worse than no rate, so the
 *  row says the var is unset rather than showing a made-up number. */
const rawAi33Rate = Number(process.env.AI33_TTS_USD_PER_MILLION_CHARS);
export const AI33_TTS_USD_PER_MILLION_CHARS =
  Number.isFinite(rawAi33Rate) && rawAi33Rate > 0 ? rawAi33Rate : null;

/** Mostly free_usage counter kinds, so a cap has a matching usage number.
 *  "voice_clones" is the exception: it caps how many clones a user may
 *  HOLD (a row count in cloned_voices), not consumption over a period, so
 *  it has no counter. Only perks we pay for are allocated here — Google
 *  TTS and Cloudflare images run on the user's own key, and Qwen isn't
 *  reachable in the picker. */
export type QuotaKind = Extract<FreeUsageKind, "ai33_tts_chars"> | "voice_clones" | "storage_bytes";

export type QuotaAllocation = {
  /** Allowance per plan slug. A slug with no entry gets nothing — every
   *  plan that should have an allowance carries its own explicit number,
   *  so a plan is never handed Heclus-paid spend by omission. */
  byPlan: Record<string, number>;
};

export type QuotaConfig = Record<QuotaKind, QuotaAllocation>;

export const QUOTA_VALUE_MAX = 50_000_000;

/** No ceiling. Only valid on fields flagged allowUnlimited — character
 *  allowances are real per-unit spend and must stay bounded, whereas a
 *  clone is a one-off that only holds an upstream slot. 0 still means
 *  "not included on this plan", so the two aren't confusable. */
export const QUOTA_UNLIMITED = -1;

/** The live-Dodo checkout verification harness, not a customer tier — it
 *  gets no quota cell and resolves to 0. */
export const QUOTA_EXCLUDED_PLAN_SLUG = "production-test";

/** "total" is a standing allowance rather than a per-period one — it
 *  resets only when the user frees a slot. */
export type QuotaPeriod = "monthly" | "daily" | "total";
/** "heclus" = our token pays per unit, so the cap is real spend. "byo" =
 *  the user's own key enforces the limit and this is a display gauge. */
export type QuotaFunding = "heclus" | "byo";

export const QUOTA_FIELDS: {
  key: QuotaKind;
  label: string;
  unit: string;
  period: QuotaPeriod;
  funding: QuotaFunding;
  /** USD the provider bills us per 1M units; null when the rate isn't
   *  configured, in which case the row shows no cost estimate. */
  usdPerMillionUnits: number | null;
  /** False for gauge-only quotas, where the provider enforces the real
   *  limit and there's nothing for an admin to allocate per plan. */
  perPlan: boolean;
  /** Whether QUOTA_UNLIMITED (-1) is an accepted value for this field. */
  allowUnlimited?: boolean;
  /** False renders the per-plan cells read-only: the allocation is fixed
   *  by product policy rather than something to tune per environment. */
  perPlanEditable?: boolean;
  description: string;
}[] = [
  {
    key: "ai33_tts_chars",
    label: "Free voiceover",
    unit: "chars",
    period: "monthly",
    funding: "heclus",
    usdPerMillionUnits: AI33_TTS_USD_PER_MILLION_CHARS,
    perPlan: true,
    description: "Chars of free voiceover per user each month. We pay for these.",
  },
  {
    key: "voice_clones",
    label: "Custom voice clones",
    unit: "voices",
    period: "total",
    funding: "heclus",
    // Priced per clone by ai33, not per unit, so there's no /1M rate to
    // show — the row stays cost-free rather than printing a fake figure.
    usdPerMillionUnits: null,
    perPlan: true,
    allowUnlimited: true,
    // Fixed policy for now: unlimited on Pro, off everywhere else. Shown
    // read-only so the numbers are visible without inviting a tweak that
    // would quietly widen who can clone.
    perPlanEditable: false,
    description: "How many cloned voices a user can keep at once. Each one holds a slot on our shared voice-provider account. -1 = unlimited, 0 = not included.",
  },
  {
    key: "storage_bytes",
    label: "Asset storage",
    // Stored and enforced in GB so the admin cell is a sane number; the
    // usage side converts from bytes. QUOTA_VALUE_MAX caps it at 50M, which
    // is 50 petabytes — no practical ceiling.
    unit: "GB",
    period: "total",
    funding: "heclus",
    // R2 is ~$0.015/GB-month, so a per-1M-units rate would round to zero
    // and print a misleading $0.00.
    usdPerMillionUnits: null,
    perPlan: true,
    allowUnlimited: true,
    description: "Total R2 storage for a user's images, clips, voiceovers and exports. -1 = unlimited. At the cap, new writes are blocked until they delete or upgrade.",
  },
];

/** The env/constant baseline — how the product behaved before this config
 *  existed. Used only when the product_config row can't be read, so an
 *  unapplied migration 104 doesn't zero the perk for every user. Not
 *  exposed in the admin UI. */
export const QUOTA_DEFAULTS: QuotaConfig = {
  ai33_tts_chars: {
    byPlan: { founder: 0, starter: AI33_TTS_CAP_STARTER, pro: AI33_TTS_CAP_PRO },
  },
  voice_clones: {
    // Unlimited for Pro; Starter is 0 for now, so the feature ships to Pro
    // only. Both are admin-tunable, so opening it to Starter — unlimited or
    // capped — is a config change, not a deploy.
    byPlan: { founder: 0, starter: 0, pro: QUOTA_UNLIMITED },
  },
  storage_bytes: {
    // Comfortably above measured usage: the heaviest account holds 37.9 GB
    // and p90 is 6.9 GB, so nobody is retroactively over cap. For scale, a
    // user sitting at the 200 GB Pro cap is ~$3/month of actual R2 cost.
    //
    // There is no paid storage add-on, matching the category: InVideo and
    // peers treat storage as a fixed entitlement and resolve overage by
    // deleting media or moving up a tier. Hitting the cap therefore blocks
    // new writes rather than billing for more.
    byPlan: { founder: 100, starter: 100, pro: 200 },
  },
};

function coerceValue(raw: unknown, allowUnlimited = false): number | null {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (allowUnlimited && i === QUOTA_UNLIMITED) return QUOTA_UNLIMITED;
  if (i < 0 || i > QUOTA_VALUE_MAX) return null;
  return i;
}

/** Anything missing or out of range falls back per-field, so one bad
 *  number can't brick every quota. */
export function coerceQuotaConfig(raw: unknown): QuotaConfig {
  const out: QuotaConfig = {
    ai33_tts_chars: { byPlan: { ...QUOTA_DEFAULTS.ai33_tts_chars.byPlan } },
    voice_clones: { byPlan: { ...QUOTA_DEFAULTS.voice_clones.byPlan } },
    storage_bytes: { byPlan: { ...QUOTA_DEFAULTS.storage_bytes.byPlan } },
  };
  if (!raw || typeof raw !== "object") return out;

  for (const f of QUOTA_FIELDS) {
    const entry = (raw as Record<string, unknown>)[f.key];
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;

    // A stored byPlan REPLACES the baseline map instead of merging, so an
    // admin clearing a plan's allowance actually zeroes it — merging would
    // silently resurrect the baseline number.
    if (e.byPlan && typeof e.byPlan === "object") {
      const byPlan: Record<string, number> = {};
      for (const [slug, v] of Object.entries(e.byPlan as Record<string, unknown>)) {
        const key = slug.trim().toLowerCase();
        if (!key) continue;
        const n = coerceValue(v, f.allowUnlimited);
        if (n !== null) byPlan[key] = n;
      }
      out[f.key].byPlan = byPlan;
    }
  }
  return out;
}

const CACHE_TTL_MS = 15_000;
let cached: { at: number; value: QuotaConfig } | null = null;

/** Cached so per-synthesis cap checks don't hammer Supabase. Falls back
 *  to defaults on error — a misconfigured DB must never block a
 *  generation the env-var path would have allowed. */
export async function getQuotaConfig(): Promise<QuotaConfig> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;

  try {
    const { data } = await supabase
      .from("product_config")
      .select("free_quotas")
      .eq("service", "_global")
      .single();
    const value = coerceQuotaConfig((data as { free_quotas?: unknown } | null)?.free_quotas);
    cached = { at: now, value };
    return value;
  } catch {
    return QUOTA_DEFAULTS;
  }
}

export function invalidateQuotaConfigCache(): void {
  cached = null;
}

/** Admins resolve as Pro, matching the pre-config behaviour. A plan with
 *  no configured allowance gets 0 — fail closed, since these characters
 *  are spend we cover. */
export function capFromConfig(
  config: QuotaConfig,
  kind: QuotaKind,
  plan: string | null | undefined,
  isAdmin = false,
): number {
  const slug = isAdmin ? "pro" : (plan ?? "").trim().toLowerCase();
  const allowance = config[kind].byPlan[slug];
  return typeof allowance === "number" ? allowance : 0;
}

export async function resolveQuotaCap(
  kind: QuotaKind,
  plan: string | null | undefined,
  isAdmin = false,
): Promise<number> {
  return capFromConfig(await getQuotaConfig(), kind, plan, isAdmin);
}

export function validateQuotaInput(input: unknown): { ok: true; value: QuotaConfig } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "Body must be an object" };

  for (const f of QUOTA_FIELDS) {
    const entry = (input as Record<string, unknown>)[f.key];
    if (entry === undefined) continue;
    if (!entry || typeof entry !== "object") {
      return { ok: false, error: `${f.label}: expected an object with a "byPlan" map` };
    }
    const e = entry as Record<string, unknown>;
    if (e.byPlan !== undefined) {
      if (!e.byPlan || typeof e.byPlan !== "object" || Array.isArray(e.byPlan)) {
        return { ok: false, error: `${f.label}: byPlan must be an object keyed by plan slug` };
      }
      for (const [slug, v] of Object.entries(e.byPlan as Record<string, unknown>)) {
        if (coerceValue(v, f.allowUnlimited) === null) {
          const range = `a whole number between 0 and ${QUOTA_VALUE_MAX.toLocaleString()}`;
          return {
            ok: false,
            error: `${f.label} → ${slug}: must be ${range}${f.allowUnlimited ? ", or -1 for unlimited" : ""}`,
          };
        }
      }
    }
  }

  return { ok: true, value: coerceQuotaConfig(input) };
}
