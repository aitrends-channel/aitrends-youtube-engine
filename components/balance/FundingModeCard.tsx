"use client";

import { useState } from "react";
import useSWR from "swr";
import { Key, Wallet } from "lucide-react";
import type { FundingStatus } from "@/app/api/me/funding/route";

const fetcher = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));

// Who pays for this account's generations.
//
// Presented as a choice the customer makes, with the trade-off stated rather
// than implied: their own key is cheaper per generation and locked to KIE,
// because PoYo runs on Heclus's key only. Heclus Credits opens every model and
// needs nothing connected.
//
// Switching does not touch the subscription. The price only changes at the next
// renewal, and that is said here rather than discovered on a statement.
export function FundingModeCard() {
  const { data, isLoading, mutate } = useSWR<FundingStatus>("/api/me/funding", fetcher, {
    revalidateOnFocus: false,
  });
  const [saving, setSaving] = useState<"byo" | "wallet" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"byo" | "wallet" | null>(null);

  async function choose(mode: "byo" | "wallet") {
    setSaving(mode);
    setError(null);
    try {
      const res = await fetch("/api/me/funding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode }),
      });
      const body = await res.json() as { error?: string };
      if (!res.ok) setError(body.error ?? "Could not switch. Try again.");
      else await mutate();
    } catch {
      setError("Could not switch. Try again.");
    } finally {
      setSaving(null);
      setConfirming(null);
    }
  }

  const mode = data?.mode;
  const repricesAtRenewal = !!data?.heclusPlan;

  return (
    <div className="p-5 rounded-2xl space-y-4"
      style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" }}>
      <div>
        <h2 className="text-lg font-bold text-foreground">How your generations are paid for</h2>
        <p className="text-xs mt-1" style={{ color: "var(--c-45)" }}>
          Switch whenever you like. Your keys and your credits both stay where they are, so changing
          your mind costs nothing.
        </p>
      </div>

      {isLoading && <p className="text-xs" style={{ color: "var(--c-45)" }}>Loading…</p>}

      {data && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Option
            icon={<Key size={16} />}
            title="Your own KIE key"
            selected={mode === "byo"}
            disabled={!data.canUseByo || saving !== null}
            blocked={data.byoBlockedReason}
            lines={[
              "Your KIE balance pays for every generation.",
              "KIE models only. Everything else runs on our account.",
              "Your subscription and renewals stay exactly as they are.",
            ]}
            onSelect={() => choose("byo")}
            busy={saving === "byo"}
          />
          <Option
            icon={<Wallet size={16} />}
            title="Heclus Credits"
            selected={mode === "wallet"}
            disabled={!data.canUseWallet || saving !== null}
            blocked={data.walletBlockedReason}
            lines={[
              "We pay the providers and meter it in credits.",
              "Every model, nothing to connect.",
              repricesAtRenewal
                ? "Your plan moves to Heclus Credits pricing at your next renewal."
                : "You are already on Heclus Credits pricing.",
            ]}
            onSelect={() => (repricesAtRenewal ? setConfirming("wallet") : choose("wallet"))}
            busy={saving === "wallet"}
          />
        </div>
      )}

      {/* The one consequence that is not reversible by clicking back, so it is
          confirmed rather than assumed. */}
      {confirming === "wallet" && data && (
        <div className="p-4 rounded-xl space-y-3"
          style={{ background: "oklch(0.72 0.16 60 / 0.10)", border: "1px solid oklch(0.72 0.16 60 / 0.30)" }}>
          <p className="text-sm font-semibold text-foreground">Your plan changes at renewal</p>
          <p className="text-xs" style={{ color: "var(--c-55)" }}>
            You keep your current plan and price until the end of this billing period. After that your
            subscription moves to Heclus Credits pricing, and we will email you before it renews.
            Nothing is charged today.
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={() => choose("wallet")} disabled={saving !== null}
              className="px-3 py-2 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
              style={{ background: "oklch(0.72 0.25 285)", color: "white" }}>
              {saving === "wallet" ? "Switching…" : "Switch to Heclus Credits"}
            </button>
            <button type="button" onClick={() => setConfirming(null)} disabled={saving !== null}
              className="px-3 py-2 rounded-lg text-sm font-medium transition-all hover:opacity-80 disabled:opacity-50"
              style={{ color: "var(--c-55)" }}>
              Keep my current setup
            </button>
          </div>
        </div>
      )}

      {error && <p className="text-xs" style={{ color: "oklch(0.65 0.2 25)" }}>{error}</p>}
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
        <span className="text-sm font-semibold text-foreground">{title}</span>
        {selected && (
          <span className="text-[10px] uppercase tracking-wider px-2 py-0.5 rounded-full"
            style={{ background: "oklch(0.72 0.25 285 / 0.18)", color: "oklch(0.72 0.25 285)" }}>
            Current
          </span>
        )}
      </div>
      <ul className="mt-2 space-y-1">
        {lines.map((l) => (
          <li key={l} className="text-xs" style={{ color: "var(--c-50)" }}>{l}</li>
        ))}
      </ul>
      {/* Why it cannot be picked, in place. A greyed option with no reason is
          the thing customers write in about. */}
      {blocked && !selected && (
        <p className="text-xs mt-2" style={{ color: "oklch(0.72 0.16 60)" }}>{blocked}</p>
      )}
      {busy && <p className="text-xs mt-2" style={{ color: "var(--c-45)" }}>Switching…</p>}
    </button>
  );
}
