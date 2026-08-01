"use client";

import { QUOTA_VALUE_MAX, QUOTA_UNLIMITED } from "@/lib/quota-config";
import { isQuotaValueValid } from "./draft";

/** One plan's allowance cell. `locked` renders it read-only — either the
 *  plan can't carry an allowance (founder) or the field is fixed by product
 *  policy. A locked cell with a real allowance keeps full contrast; only
 *  "nothing here" cells dim. */
export function QuotaInput({
  label, hint, unit, value, savedValue, disabled, locked = false, allowUnlimited = false, onChange,
}: {
  label: string;
  hint: string;
  unit: string;
  value: string;
  savedValue: number | undefined;
  disabled: boolean;
  locked?: boolean;
  allowUnlimited?: boolean;
  onChange: (value: string) => void;
}) {
  const valid = isQuotaValueValid(value, allowUnlimited);
  const isUnlimited = value.trim() === String(QUOTA_UNLIMITED);
  return (
    <div className="p-2.5 rounded-lg" style={{
      background: "white",
      border: "1px solid oklch(0 0 0 / 0.07)",
      minWidth: 140,
      opacity: locked && !isUnlimited ? 0.55 : 1,
    }}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] font-semibold" style={{ color: "var(--c-90)" }}>{label}</span>
        <span className="text-[9px] tabular-nums" style={{ color: "var(--c-42)" }}>{hint}</span>
      </div>
      <input
        type={isUnlimited ? "text" : "number"}
        inputMode="numeric"
        min={allowUnlimited ? QUOTA_UNLIMITED : 0}
        max={QUOTA_VALUE_MAX}
        step={1}
        value={isUnlimited ? "unlimited" : value}
        placeholder="0"
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || locked}
        title={isUnlimited ? "Unlimited — no per-user ceiling"
          : locked ? "Fixed by product policy"
          : allowUnlimited ? "-1 = unlimited, 0 = not included"
          : undefined}
        className="mt-2 w-full px-2 py-2 rounded-md text-sm outline-none transition-all tabular-nums text-center disabled:cursor-not-allowed"
        style={{
          background: "var(--bg-input)",
          border: `1px solid ${valid ? "var(--bd-10)" : "oklch(0.62 0.18 25 / 0.5)"}`,
          color: "var(--c-90)",
        }}
      />
      <p className="text-[9px] mt-1 text-center" style={{ color: "var(--c-42)" }}>
        {isUnlimited ? "unlimited"
          : locked && (value.trim() === "" || value.trim() === "0") ? "not included"
          : unit}
      </p>
      <p className="text-[9px] mt-1.5 text-center tabular-nums" style={{ color: "var(--c-42)" }}>
        saved{" "}
        <span className="font-semibold" style={{ color: "var(--c-90)" }}>
          {savedValue === undefined ? "—"
            : savedValue === QUOTA_UNLIMITED ? "unlimited"
            : savedValue.toLocaleString()}
        </span>
      </p>
    </div>
  );
}
