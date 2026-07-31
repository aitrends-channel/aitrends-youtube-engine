"use client";

import type { QUOTA_FIELDS, QuotaAllocation } from "@/lib/quota-config";
import { QuotaInput } from "./QuotaInput";
import { parseQuotaValue, type PlanRef } from "./draft";

type QuotaField = (typeof QUOTA_FIELDS)[number];

/** One quota card: header, description, Save, the per-plan grid, and what
 *  the allocation costs us at the provider's rate. */
export function QuotaRow({
  field, saved, draftByPlan, plans, dirty, valid, saving, savingOther, disabled,
  onOverrideChange, onSave,
}: {
  field: QuotaField;
  saved: QuotaAllocation | undefined;
  draftByPlan: Record<string, string>;
  plans: PlanRef[];
  dirty: boolean;
  valid: boolean;
  saving: boolean;
  savingOther: boolean;
  disabled: boolean;
  onOverrideChange: (slug: string, value: string) => void;
  onSave: () => void;
}) {
  const canSave = dirty && valid && !saving && !savingOther;
  const isPerk = field.funding === "heclus";
  const unitLabel = field.period === "total"
    ? field.unit
    : `${field.unit}/${field.period === "daily" ? "day" : "month"}`;
  const rate = field.usdPerMillionUnits;

  // Cost per user on each plan that actually has an allowance — the number
  // an admin needs before raising a cap, since we're billed for every one
  // of these characters.
  const costed = rate === null ? [] : plans
    .map((p) => ({ plan: p, units: parseQuotaValue(draftByPlan[p.slug] ?? "") ?? 0 }))
    .filter((r) => r.units > 0)
    .map((r) => ({ ...r, usd: (r.units / 1_000_000) * rate }));

  return (
    <div className="p-4 rounded-xl"
      style={{ background: "oklch(0 0 0 / 0.02)", border: "1px solid oklch(0 0 0 / 0.06)" }}>
      <div className="flex items-start gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-x-2 gap-y-1.5 flex-wrap">
            <label className="text-xs font-semibold" style={{ color: "var(--c-90)" }}>
              {field.label}
            </label>
            <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold"
              style={isPerk ? {
                background: "oklch(0.62 0.15 220 / 0.12)",
                color: "oklch(0.5 0.15 220)",
              } : {
                background: "oklch(0 0 0 / 0.05)",
                color: "var(--c-50)",
              }}>
              {isPerk ? "Heclus pays" : "Gauge only"}
            </span>
            <span className="text-[10px]" style={{ color: "var(--c-42)" }}>
              {unitLabel}
            </span>
            {rate !== null && (
              <span className="text-[10px] font-semibold tabular-nums" style={{ color: "oklch(0.5 0.15 220)" }}>
                ai33 bills ${rate.toFixed(2)}/1M {field.unit}
              </span>
            )}
          </div>
          <p className="text-xs mt-1.5 leading-relaxed" style={{ color: "var(--c-50)" }}>
            {field.description}
          </p>
        </div>
        <button
          onClick={onSave}
          disabled={!canSave}
          className="px-3.5 py-2 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shrink-0"
          style={{
            background: canSave ? "oklch(0.62 0.15 220)" : "oklch(0 0 0 / 0.06)",
            color: canSave ? "white" : "var(--c-50)",
            minWidth: 72,
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>

      {field.perPlan ? (
        <div className="mt-4 flex flex-wrap gap-2.5">
          {plans.map((p) => (
            <QuotaInput
              key={p.slug}
              label={p.name}
              hint={p.slug}
              unit={unitLabel}
              value={draftByPlan[p.slug] ?? ""}
              savedValue={typeof saved?.byPlan[p.slug] === "number" ? saved.byPlan[p.slug] : undefined}
              disabled={disabled}
              locked={p.isFounder}
              onChange={(v) => onOverrideChange(p.slug, v)}
            />
          ))}
        </div>
      ) : (
        <p className="text-[11px] mt-3 leading-relaxed" style={{ color: "var(--c-42)" }}>
          Per-plan allocation is disabled for this quota — the provider enforces the real limit.
        </p>
      )}

      {!field.perPlan || rate === null ? null : costed.length === 0 ? (
        <p className="text-[11px] mt-3 leading-relaxed" style={{ color: "var(--c-42)" }}>
          No plan has an allowance — costs us nothing.
        </p>
      ) : (
        <p className="text-[11px] mt-3 leading-relaxed tabular-nums" style={{ color: "var(--c-50)" }}>
          Costs us at most{" "}
          {costed.map((r, i) => (
            <span key={r.plan.slug}>
              {i > 0 && ", "}
              <span className="font-semibold" style={{ color: "var(--c-90)" }}>
                ${r.usd.toFixed(2)}
              </span>
              {" / "}{r.plan.name} user / month
            </span>
          ))}
          {" — if every user spends their full allowance."}
        </p>
      )}
    </div>
  );
}
