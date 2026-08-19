"use client";

import { useState, useEffect } from "react";
import { Sparkles, Wallet } from "lucide-react";
import { TopUpOptions } from "@/components/TopUpOptions";

// The two wallets, and the fetching behind them.
//
// Lifted out of the account page when Balance became its own route. They live
// together because they answer one question between them ("what can I spend?")
// and because keeping them in one file is what lets the page be a shell.
//
// Two fetches, not one. They are separate wallets with separate ledgers, counted
// in different units — whole video clips there, fractional credits here — so a
// merged payload would produce numbers on screen that could not say which
// balance they came from. It also means one failing leaves the other readable.

interface CreditsData {
  grant: number; paid: number; total: number; reserved: number;
  monthlyGrant: number; eligible: boolean;
  used?: { thisMonth: number; allTime: number };
  setupHint?: string | null;
  pack: { credits: number; priceUsd: number };
  checkoutUrl: string | null;
  ledger: { id: string; kind: string; credits: number; note: string | null; created_at: string }[];
}

interface HeclusCreditsData {
  credits: number;
  reserved: number;
  ledger: { id: string; kind: string; credits: number; note: string | null; provider: string | null; created_at: string }[];
  pack: { credits: number; priceUsd: number } | null;
  checkoutUrl: string | null;
}

/** Heclus Credits: the general wallet, bought from us and spent on work that runs
 *  on Heclus's own provider accounts.
 *
 *  Always rendered, unlike the free video wallet beside it. That one hides when a
 *  plan has no allowance, because there was nothing true to say; this one is the
 *  thing anyone can buy, so a zero balance is information rather than an absence.
 */
function HeclusCreditsCard({ data }: { data: HeclusCreditsData | null }) {
  const credits = data?.credits ?? 0;
  const reserved = data?.reserved ?? 0;
  const ledger = data?.ledger ?? [];

  const label = (kind: string, provider: string | null) => {
    switch (kind) {
      case "topup":      return "Credits purchased";
      case "refund":     return "Refunded";
      case "adjustment": return "Adjusted by Heclus";
      // Spend rows name the provider, since that is the part a user recognises:
      // "spent" alone tells them nothing about which step took it.
      default:           return provider ? `Spent on ${provider}` : "Spent";
    }
  };

  return (
    <div className="space-y-4 flex flex-col h-full">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
          <Wallet size={18} style={{ color: "oklch(0.72 0.25 285)" }} />
        </div>
        <div>
          <h2 className="text-lg font-bold text-foreground">Heclus Credits</h2>
          <p className="text-xs" style={{ color: "var(--c-45)" }}>
            Buy credit from us and spend it across the workflow, with no provider key of your own to manage.
          </p>
        </div>
      </div>

      <div className="rounded-2xl p-5 space-y-3 flex flex-col justify-center" style={{ background: "var(--bg-card)", border: "1px solid var(--bd-8)", flex: "1 1 auto" }}>
        <div className="flex items-end justify-between gap-3">
          <p className="leading-none">
            <span className="text-3xl font-bold text-foreground tabular-nums">
              {credits.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
            <span className="text-sm ml-2" style={{ color: "var(--c-45)" }}>
              credit{credits === 1 ? "" : "s"}
            </span>
          </p>
          {/* The button is always here, so the wallet reads the same as the one
              beside it. Disabled until a pack is configured, rather than hidden:
              its absence looked like a missing feature, and a link to a checkout
              that grants nothing is worse than a button that says why. */}
          {data?.checkoutUrl && data.pack ? (
            <a
              href={data.checkoutUrl}
              title={`${data.pack.credits.toLocaleString()} credits for $${data.pack.priceUsd}`}
              className="px-4 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 shrink-0"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
            >
              Top up
            </a>
          ) : (
            <button
              type="button"
              disabled
              title="No top-up pack is configured yet, so this cannot charge anything."
              className="px-4 py-2 rounded-xl text-sm font-semibold shrink-0 opacity-40 cursor-not-allowed"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
            >
              Top up
            </button>
          )}
        </div>
        {!data?.checkoutUrl && (
          <p className="text-[11px] leading-relaxed" style={{ color: "var(--c-42)" }}>
            Top-ups are not open yet. Nothing is charged, and nothing is spent from this balance.
          </p>
        )}
        {reserved > 0 && (
          <p className="text-[11px]" style={{ color: "var(--c-42)" }}>
            {reserved.toLocaleString(undefined, { maximumFractionDigits: 2 })} held by work in progress
          </p>
        )}
      </div>

      {ledger.length > 0 && (
        <div className="rounded-2xl overflow-hidden" style={{ background: "var(--bg-card)", border: "1px solid var(--bd-8)" }}>
          <p className="px-4 py-3 text-xs font-semibold" style={{ color: "var(--c-55)", borderBottom: "1px solid var(--bd-8)" }}>
            Recent activity
          </p>
          {ledger.map((row) => (
            <div key={row.id} className="flex items-center justify-between gap-3 px-4 py-3"
              style={{ borderTop: "1px solid var(--bd-6)" }}>
              <div className="min-w-0">
                <p className="text-sm truncate" style={{ color: "var(--c-75)" }}>{label(row.kind, row.provider)}</p>
                <p className="text-[11px]" style={{ color: "var(--c-42)" }}>
                  {new Date(row.created_at).toLocaleString()}
                </p>
              </div>
              <span className="text-sm font-semibold tabular-nums shrink-0"
                style={{ color: row.credits > 0 ? "oklch(0.7 0.15 145)" : "var(--c-55)" }}>
                {row.credits > 0 ? "+" : ""}{row.credits.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Video credits. Mirrors StorageCard's shape because it answers the same kind
 *  of question, and like it, renders nothing when there is nothing true to say:
 *  a plan with no allowance and no bought credit has no wallet, which is how
 *  Founder never sees this. `eligible` is decided server-side. */
function WalletCard({ data }: { data: CreditsData | null }) {
  // Opening the picker in place of the balance row, not over it. A modal would
  // hide the balance behind the decision it informs.
  const [picking, setPicking] = useState(false);
  // Eligible means "already has an allowance or bought credit". That was the
  // right gate while the wallet only existed to spend a monthly perk, but it
  // shuts out the person this page is now for: someone with nothing who wants to
  // buy some. If there is a top-up link, there is something true to say, so the
  // card renders and the zero state is the invitation.
  //
  // Still nothing when no checkout link is configured: a balance of zero with no
  // way to change it is the one case where saying nothing is kinder.
  if (!data || (!data.eligible && !data.checkoutUrl)) return null;

  const { grant, paid, total, reserved, monthlyGrant, checkoutUrl, ledger, setupHint, used: usage } = data;
  const used = Math.max(monthlyGrant - grant, 0);
  const pct = monthlyGrant > 0 ? Math.min(used / monthlyGrant, 1) : 0;
  const empty = total === 0;
  const barColor = empty
    ? "oklch(0.6 0.19 25)"
    : pct >= 0.9
      ? "oklch(0.72 0.17 75)"
      : "oklch(0.72 0.25 285)";

  // Ledger rows in the customer's terms. The stored note is written for
  // support, so the kind decides the wording here.
  const label = (kind: string, note: string | null) => {
    switch (kind) {
      case "monthly_grant": return "Monthly free credits";
      case "grant_expiry":  return "Unused free credits expired";
      case "topup":         return "Credits purchased";
      case "debit":         return note ? `Video clip (${note})` : "Video clip";
      case "refund":        return "Refunded — clip did not render";
      default:              return "Adjustment";
    }
  };

  return (
    <div className="space-y-5 flex flex-col h-full">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
          <Sparkles size={18} style={{ color: "oklch(0.72 0.25 285)" }} />
        </div>
        <div>
          <h2 className="text-lg font-bold text-foreground">Free video credits</h2>
          <p className="text-xs" style={{ color: "var(--c-45)" }}>
            One credit generates one free video clip. Refreshes every month; purchased clip credits never expire. Separate from Heclus Credits.
          </p>
        </div>
      </div>

      <div className="p-5 rounded-2xl space-y-3"
        style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" }}>
        <div className="flex items-end justify-between gap-3 flex-wrap">
          <p className="leading-none">
            <span className="text-2xl font-bold tabular-nums" style={{ color: "var(--c-90)" }}>
              {total.toLocaleString()}
            </span>
            <span className="text-xs ml-1.5" style={{ color: "var(--c-50)" }}>
              credits left{reserved > 0 ? ` · ${reserved} in use right now` : ""}
            </span>
          </p>
          {checkoutUrl && !picking && (
            <button type="button" onClick={() => setPicking(true)}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg transition-all hover:opacity-90"
              style={{ background: "oklch(0.72 0.25 285)", color: "white" }}>
              Top up
            </button>
          )}
        </div>

        {/* Replaces the meter and the usage line while open: the amounts are the
            decision at hand, and leaving the button up alongside them would give
            two ways to start the same purchase. */}
        {checkoutUrl && picking && (
          <TopUpOptions checkoutUrl={checkoutUrl} onCancel={() => setPicking(false)} />
        )}

        {monthlyGrant > 0 && !picking && (
          <div className="h-2 rounded-full overflow-hidden" style={{ background: "oklch(0 0 0 / 0.18)" }}>
            <div className="h-full rounded-full transition-all"
              style={{ width: `${Math.max(pct * 100, 1.5)}%`, background: barColor }} />
          </div>
        )}

        {!picking && (
        <p className="text-[11px] leading-relaxed" style={{ color: empty ? "oklch(0.68 0.19 25)" : "var(--c-42)" }}>
          {usage ? `${usage.thisMonth.toLocaleString()} used this month · ` : ""}
          {monthlyGrant > 0
            ? `${grant.toLocaleString()} of this month's ${monthlyGrant.toLocaleString()} free credits left`
            : "No monthly credits on your plan"}
          {paid > 0 && ` · ${paid.toLocaleString()} purchased`}
          {/* Only promise next month's credits to someone whose plan actually
              grants them. For a user with no allowance, the top-up is the only
              route and saying otherwise sends them away to wait for nothing. */}
          {empty && (monthlyGrant > 0
            ? ". Top up to keep generating, or wait for next month's free credits."
            : ". Top up to start generating.")}
        </p>
        )}
        {!picking && usage && usage.allTime > usage.thisMonth && (
          <p className="text-[11px]" style={{ color: "var(--c-42)" }}>
            {usage.allTime.toLocaleString()} used in total
          </p>
        )}
      </div>

      {setupHint && (
        <p className="text-[11px] leading-relaxed px-4 py-2.5 rounded-xl"
          style={{ background: "oklch(0.72 0.18 65 / 0.1)", border: "1px solid oklch(0.72 0.18 65 / 0.3)", color: "var(--accent-amber-text)" }}>
          {setupHint}
        </p>
      )}

      {ledger.length > 0 && (
        <div className="rounded-2xl overflow-hidden"
          style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" }}>
          <p className="text-xs font-semibold px-4 py-2.5" style={{ color: "var(--c-55)", borderBottom: "1px solid oklch(1 0 0 / 0.07)" }}>
            Recent activity
          </p>
          <ul>
            {ledger.slice(0, 8).map((row) => (
              <li key={row.id} className="flex items-start justify-between gap-3 px-4 py-2"
                style={{ borderTop: "1px solid oklch(1 0 0 / 0.04)" }}>
                <span className="min-w-0">
                  <span className="text-xs block truncate" style={{ color: "var(--c-70)" }}>
                    {label(row.kind, row.note)}
                  </span>
                  <span className="text-[10px] block" style={{ color: "var(--c-42)" }}>
                    {new Date(row.created_at).toLocaleString(undefined, {
                      day: "numeric", month: "short", year: "numeric",
                      hour: "2-digit", minute: "2-digit",
                    })}
                  </span>
                </span>
                <span className="text-xs font-semibold tabular-nums shrink-0"
                  style={{ color: row.credits > 0 ? "oklch(0.62 0.15 145)" : "var(--c-55)" }}>
                  {row.credits > 0 ? `+${row.credits}` : row.credits}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Both wallets, general first: it is the one that can be topped up.
 *
 *  Side by side from lg, stacked below it, with items-start so the shorter card
 *  is not stretched to match the taller one's ledger. */
export function BalanceCards() {
  const [credits, setCredits] = useState<CreditsData | null>(null);
  const [heclusCredits, setHeclusCredits] = useState<HeclusCreditsData | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/credits", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (!cancelled && d && typeof d.total === "number") setCredits(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Failure leaves this null and the card shows zero, which is the truth for
    // anyone who has not topped up. It must not take the other wallet down.
    fetch("/api/heclus-credits", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (!cancelled && d && typeof d.credits === "number") setHeclusCredits(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  return (
    // items-stretch (the default) rather than items-start, so the two columns
    // match. Each card is a flex column filling its cell, and the block that
    // grows is the one with room to spare: the ledger where there is one, the
    // balance box where there is not.
    <div className="grid gap-6 lg:grid-cols-2">
      <HeclusCreditsCard data={heclusCredits} />
      <WalletCard data={credits} />
    </div>
  );
}
