"use client";

// Visual twin of the real StepBalanceCard — the blue "Available" chip that
// sits beside the green "Used" cost chip on every workflow step. The demo
// has no live wallet, so it surfaces a static, plausible KIE + ElevenLabs
// balance purely for the showcase. Kept in the same one-liner chip shape as
// DemoStepCostCard so the two read as a matched pair.
const DEMO_BALANCE = { kie: 8_450, el: 48_900 };

export function DemoStepBalanceCard() {
  const kieDisplay = DEMO_BALANCE.kie.toLocaleString();
  const elDisplay = DEMO_BALANCE.el.toLocaleString();

  return (
    <span
      className="inline-flex items-center rounded-md overflow-hidden text-xs font-medium break-words max-w-full"
      style={{ border: "1px solid oklch(0.55 0.15 240 / 0.3)" }}
    >
      <span
        className="uppercase tracking-wider px-2 py-1"
        style={{ fontSize: "10px", background: "oklch(0.55 0.15 240)", color: "oklch(1 0 0)" }}
      >
        Available
      </span>
      <span
        className="tabular-nums px-2.5 py-1"
        style={{ background: "oklch(0.55 0.15 240 / 0.12)", color: "oklch(0.55 0.15 240)" }}
      >
        <span>Kie:</span>
        <span style={{ marginLeft: "5px" }}>{kieDisplay}</span>
        <span style={{ margin: "0 6px" }}>·</span>
        <span>El:</span>
        <span style={{ marginLeft: "5px" }}>{elDisplay}</span>
      </span>
    </span>
  );
}
