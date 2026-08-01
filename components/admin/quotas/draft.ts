import { QUOTA_FIELDS, QUOTA_VALUE_MAX, QUOTA_UNLIMITED, type QuotaConfig, type QuotaKind } from "@/lib/quota-config";

const allowsUnlimited = (key: QuotaKind) => QUOTA_FIELDS.find((f) => f.key === key)?.allowUnlimited === true;

/** slug → value, as strings so a half-typed number isn't coerced mid-edit.
 *  Blank means the plan gets no allowance (same as 0) and is dropped from
 *  the saved payload rather than stored as a zero. */
export type QuotaDraft = Record<QuotaKind, Record<string, string>>;

/** isFounder plans show a read-only cell — the founder tier deliberately
 *  carries no Heclus-paid allowance, so there's nothing to allocate. */
export type PlanRef = { slug: string; name: string; isFounder: boolean };

export function toDraft(config: QuotaConfig, plans: PlanRef[]): QuotaDraft {
  const out = {} as QuotaDraft;
  for (const f of QUOTA_FIELDS) {
    const byPlan: Record<string, string> = {};
    for (const p of plans) {
      const v = config[f.key].byPlan[p.slug];
      byPlan[p.slug] = typeof v === "number" ? String(v) : "";
    }
    out[f.key] = byPlan;
  }
  return out;
}

/** null for blank or out-of-range — callers treat blank as "no allowance".
 *  -1 parses only for fields that accept unlimited. */
export function parseQuotaValue(raw: string, allowUnlimited = false): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  if (allowUnlimited && i === QUOTA_UNLIMITED) return QUOTA_UNLIMITED;
  if (i < 0 || i > QUOTA_VALUE_MAX) return null;
  return i;
}

export function isQuotaValueValid(raw: string, allowUnlimited = false): boolean {
  if (raw.trim() === "") return true;
  return parseQuotaValue(raw, allowUnlimited) !== null;
}

export function isQuotaDirty(
  draft: QuotaDraft,
  saved: QuotaConfig,
  key: QuotaKind,
  plans: PlanRef[],
): boolean {
  for (const p of plans) {
    const drafted = parseQuotaValue(draft[key][p.slug] ?? "", allowsUnlimited(key));
    const stored = typeof saved[key].byPlan[p.slug] === "number" ? saved[key].byPlan[p.slug] : null;
    if (drafted !== stored) return true;
  }
  return false;
}

export function isQuotaValid(draft: QuotaDraft, key: QuotaKind, plans: PlanRef[]): boolean {
  return plans.every((p) => isQuotaValueValid(draft[key][p.slug] ?? "", allowsUnlimited(key)));
}

/** Blank plans are omitted, so they resolve to 0 on the server. */
export function toPayload(draft: QuotaDraft, key: QuotaKind, plans: PlanRef[]): {
  byPlan: Record<string, number>;
} {
  const byPlan: Record<string, number> = {};
  for (const p of plans) {
    const v = parseQuotaValue(draft[key][p.slug] ?? "", allowsUnlimited(key));
    if (v !== null) byPlan[p.slug] = v;
  }
  return { byPlan };
}
