"use client";

import { useState } from "react";
import useSWR from "swr";
import { Key, Wallet } from "lucide-react";
import type { FundingStatus } from "@/app/api/me/funding/route";
import { Check } from "lucide-react";

const fetcher = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));

// Who pays for this account's generations.
//
// Presented as a choice the customer makes, with the trade-off stated rather
// than implied: their own key is cheaper per generation and locked to KIE,
// because PoYo runs on Heclus's key only. Heclus Credits opens every model and
// needs nothing connected.
//
// Switching to the wallet books the repricing for the next renewal. Nothing is
// charged today, the booked date and price are shown back rather than left to be
// discovered on a statement, and switching back before then cancels it.
export function FundingModeCard() {
  const { data, isLoading, mutate } = useSWR<FundingStatus>("/api/me/funding", fetcher, {
    revalidateOnFocus: false,
  });
  const [saving, setSaving] = useState<"byo" | "wallet" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"byo" | "wallet" | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);

  async function choose(mode: "byo" | "wallet", targetPlan?: string) {
    setSaving(mode);
    setError(null);
    setWarning(null);
    try {
      const res = await fetch("/api/me/funding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, ...(targetPlan ? { targetPlan } : {}) }),
      });
      const body = await res.json() as { error?: string; warning?: string };
      if (!res.ok) setError(body.error ?? "Could not switch. Try again.");
      else {
        setWarning(body.warning ?? null);
        await mutate();
        setConfirming(null);
      }
    } catch {
      setError("Could not switch. Try again.");
    } finally {
      setSaving(null);
    }
  }

  // A Heclus Credits plan does not include a bring-your-own arrangement, and
  // /setup hides the key fields for those accounts, so offering the choice here
  // would point at a switch they have no way to satisfy: byo needs a KIE key on
  // file, and there is nowhere left to put one.
  //
  // Held back rather than rendered and then removed. Deciding before the plan is
  // known means picking a wrong answer and correcting it, which is the flash.
  if (isLoading || !data) {
    return <div className="rounded-2xl" style={{ minHeight: 196, background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" }} />;
  }
  // Who this card is for: a legacy customer still spending their own KIE
  // balance, and one who has booked the move off it and might want to undo.
  //
  // Everyone else has no choice to make. A credits plan has no bring-your-own
  // arrangement, and a new signup has no key and nowhere to enter one, so the
  // card was offering "your own KIE key" with a warning underneath explaining
  // they cannot pick it. That is a decision presented to someone who has none.
  const onLegacyPlan = !data.onHeclusPlan;
  const usingOwnKeys = data.mode === "byo";
  const hasBookedSwitch = !!data.pendingPlan;
  if (!onLegacyPlan || !(usingOwnKeys || hasBookedSwitch)) return null;

  const mode = data?.mode;
  const repricesAtRenewal = !!data?.heclusPlan;
  const booked = data?.pendingPlan ? data : null;
  const asDate = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : null;
  const bookedDate = asDate(booked?.pendingPlanEffectiveAt);
  const renewsOnLabel = asDate(data?.renewsOn);
  const chosen = data?.switchOptions.find((o) => o.slug === target) ?? null;

  return (
    // The anchor the credits notice points at, so "See the options" lands on
    // the switch rather than at the top of a page it is halfway down.
    <div id="funding" className="p-5 rounded-2xl space-y-4 scroll-mt-24"
      style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" }}>
      <div>
        <h2 className="text-xl font-bold text-foreground">Billing Mode</h2>
        <p className="text-sm mt-1" style={{ color: "var(--c-45)" }}>
          Switch whenever you like. Your keys and your credits both stay where they are, so changing
          your mind costs nothing.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
          <Option
            icon={<Key size={16} />}
            title="Your own KIE key"
            selected={mode === "byo"}
            disabled={!data.canUseByo || saving !== null}
            blocked={data.byoBlockedReason}
            lines={["Billing done on your own keys"]}
            onSelect={() => choose("byo")}
            busy={saving === "byo"}
          />
          <Option
            icon={<Wallet size={16} />}
            title="Heclus Credits"
            selected={mode === "wallet"}
            disabled={!data.canUseWallet || saving !== null}
            blocked={data.walletBlockedReason}
            lines={["Billing done on our keys"]}
            onSelect={() => {
              if (!repricesAtRenewal) return choose("wallet");
              setTarget(data.switchOptions.find((o) => o.isCurrentTier)?.slug ?? data.switchOptions[0]?.slug ?? null);
              setConfirming("wallet");
            }}
            busy={saving === "wallet"}
          />
      </div>

      {booked && (
        <div className="p-3 rounded-xl text-sm" style={{ background: "oklch(0.62 0.15 220 / 0.10)", border: "1px solid oklch(0.62 0.15 220 / 0.25)" }}>
          <span className="font-semibold text-foreground">
            Renews as {booked.pendingPlanLabel}{bookedDate ? ` on ${bookedDate}` : ""}.
          </span>{" "}
          <span style={{ color: "var(--c-55)" }}>Switch back to your own key to cancel.</span>
        </div>
      )}

      {warning && <p className="text-sm" style={{ color: "oklch(0.72 0.16 60)" }}>{warning}</p>}
      {error && !confirming && <p className="text-sm" style={{ color: "oklch(0.65 0.2 25)" }}>{error}</p>}

      {confirming === "wallet" && data && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,0.5)" }}
          onClick={() => saving === null && setConfirming(null)}>
          <div className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}>
            <h2 className="text-xl font-bold text-zinc-900">Switch to Heclus Credits?</h2>
            <p className="mt-2 text-sm text-zinc-600">
              You keep your current plan and price until {renewsOnLabel ?? "your renewal"}. Nothing is charged today.
            </p>

            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {data.switchOptions.map((o) => {
                const picked = target === o.slug;
                return (
                  <button
                    key={o.slug}
                    type="button"
                    onClick={() => setTarget(o.slug)}
                    disabled={saving !== null}
                    className={`text-left p-4 rounded-xl border transition-all disabled:opacity-60 ${
                      picked ? "border-violet-500 bg-violet-50" : "border-zinc-200 hover:border-zinc-300"
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-base font-bold text-zinc-900">{o.name}</span>
                      {o.isCurrentTier && (
                        <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full bg-zinc-100 text-zinc-500">
                          Your tier
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-lg font-bold text-zinc-900">
                      {o.priceDisplay}<span className="text-sm font-medium text-zinc-500">{o.periodDisplay}</span>
                    </p>
                    <p className="text-xs text-zinc-500">{o.limitDisplay}</p>
                    <ul className="mt-3 space-y-1.5">
                      {o.features.map((f) => (
                        <li key={f} className="flex gap-2 text-xs text-zinc-600">
                          <Check size={13} className="shrink-0 mt-0.5 text-violet-500" />
                          <span>{f}</span>
                        </li>
                      ))}
                    </ul>
                  </button>
                );
              })}
            </div>

            <p className="mt-4 text-sm text-zinc-600">
              Renews as{" "}
              <span className="font-semibold text-zinc-900">
                {chosen?.name} {chosen?.priceDisplay}{chosen?.periodDisplay}
              </span>{" "}
              on {renewsOnLabel ?? "your renewal date"}.
            </p>

            {error && <p className="mt-3 text-sm font-medium" style={{ color: "oklch(0.6 0.22 25)" }}>{error}</p>}

            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setConfirming(null)}
                disabled={saving !== null}
                className="px-4 py-2 rounded-lg text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
              >
                Keep my key
              </button>
              <button
                onClick={() => target && choose("wallet", target)}
                disabled={saving !== null || !target}
                className="px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-60 flex items-center gap-2"
                style={{ background: "oklch(0.72 0.25 285)" }}
              >
                {saving === "wallet" && (
                  <span className="inline-block w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                )}
                {saving === "wallet" ? "Switching…" : "Switch"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Option(props: {
  icon: React.ReactNode;
  title: string;
  selected: boolean;
  disabled: boolean;
  blocked: string | null;
  lines: string[];
  busy: boolean;
  onSelect: () => void;
}) {
  const { icon, title, selected, disabled, blocked, lines, busy, onSelect } = props;
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled || selected}
      className="text-left p-4 rounded-xl transition-all disabled:cursor-not-allowed"
      style={{
        background: selected ? "oklch(0.72 0.25 285 / 0.12)" : "oklch(1 0 0 / 0.04)",
        border: `1px solid ${selected ? "oklch(0.72 0.25 285 / 0.45)" : "oklch(1 0 0 / 0.08)"}`,
        opacity: disabled && !selected ? 0.55 : 1,
      }}
    >
      <div className="flex items-center gap-2">
        <span style={{ color: selected ? "oklch(0.72 0.25 285)" : "var(--c-45)" }}>{icon}</span>
        <span className="text-base font-semibold text-foreground">{title}</span>
        {selected && (
          <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full"
            style={{ background: "oklch(0.72 0.25 285 / 0.18)", color: "oklch(0.72 0.25 285)" }}>
            Current
          </span>
        )}
      </div>
      <ul className="mt-2 space-y-1">
        {lines.map((l) => (
          <li key={l} className="text-sm" style={{ color: "var(--c-50)" }}>{l}</li>
        ))}
      </ul>
      {/* Why it cannot be picked, in place. A greyed option with no reason is
          the thing customers write in about. */}
      {blocked && !selected && (
        <p className="text-sm mt-2" style={{ color: "oklch(0.72 0.16 60)" }}>{blocked}</p>
      )}
      {busy && <p className="text-sm mt-2" style={{ color: "var(--c-45)" }}>Switching…</p>}
    </button>
  );
}
