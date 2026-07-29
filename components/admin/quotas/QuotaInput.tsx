"use client";

import { QUOTA_VALUE_MAX } from "@/lib/quota-config";
import { isQuotaValueValid } from "./draft";

/** One plan's allowance cell. `locked` renders it read-only for plans that
 *  can't carry an allowance (the founder tier). */
export function QuotaInput({
  label, hint, unit, value, savedValue, disabled, locked = false, onChange,
}: {
  label: string;
  hint: string;
  unit: string;
  value: string;
  savedValue: number | undefined;
  disabled: boolean;
  locked?: boolean;
  onChange: (value: string) => void;
}) {
  const valid = isQuotaValueValid(value);
  return (
    <div className="p-2.5 rounded-lg" style={{
      background: "white",
      border: "1px solid oklch(0 0 0 / 0.07)",
      minWidth: 140,
      opacity: locked ? 0.55 : 1,
    }}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold" style={{ color: "var(--c-90)" }}>{label}</span>
        <span className="text-[9px] tabular-nums" style={{ color: "var(--c-42)" }}>{hint}</span>
      </div>
      <input
        type="number"
        inputMode="numeric"
        min={0}
        max={QUOTA_VALUE_MAX}
        step={1}
        value={value}
        placeholder="0"
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || locked}
        title={locked ? "Not included on the founder plan" : undefined}
        className="mt-2 w-full px-2 py-2 rounded-md text-sm outline-none transition-all tabular-nums text-center disabled:cursor-not-allowed"
        style={{
          background: "var(--bg-input)",
          border: `1px solid ${valid ? "var(--bd-10)" : "oklch(0.62 0.18 25 / 0.5)"}`,
          color: "var(--c-90)",
        }}
      />
      <p className="text-[9px] mt-1 text-center" style={{ color: "var(--c-42)" }}>
        {locked ? "not included" : unit}
      </p>
      <p className="text-[9px] mt-1.5 text-center tabular-nums" style={{ color: "var(--c-42)" }}>
        saved{" "}
        <span className="font-semibold" style={{ color: "var(--c-90)" }}>
          {savedValue === undefined ? "—" : savedValue.toLocaleString()}
        </span>
      </p>
    </div>
  );
}
