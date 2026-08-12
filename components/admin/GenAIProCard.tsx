"use client";

import useSWR from "swr";
import { AlertTriangle, Sparkles } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

// GenAIPro account health, against what has been promised to customers.
//
// The alert is not "the account is low", it is "customers hold more credit than
// the account can serve". A user discovering that by having a render fail is
// the one outcome that makes this worse than letting them use their own key, so
// the shortfall is the headline rather than a footnote.

const fetcher = (url: string) => fetch(url).then((r) => r.json());

interface Response {
  account: { quota: number; used: number; remaining: number; expiresAt: string | null } | null;
  accountError: string | null;
  wallet: {
    promised: number; promisedGrant: number; promisedPaid: number;
    reserved: number; accounts: number; shortfall: number | null;
  };
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-[10px] uppercase tracking-wider" style={{ color: "var(--c-45)" }}>{label}</p>
      <p className="text-lg font-bold tabular-nums" style={{ color: tone ?? "var(--c-90)" }}>{value}</p>
      {hint && <p className="text-[10px] mt-0.5" style={{ color: "var(--c-45)" }}>{hint}</p>}
    </div>
  );
}

export function GenAIProCard() {
  const { data, isLoading } = useSWR<Response>("/api/admin/genaipro", fetcher, { refreshInterval: 60_000 });

  if (isLoading) {
    return (
      <div className="rounded-2xl p-5 flex items-center gap-2 text-sm"
        style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)", color: "var(--c-45)" }}>
        <Spinner size={14} /> Reading the GenAIPro account…
      </div>
    );
  }
  if (!data) return null;

  const { account, accountError, wallet } = data;
  const short = (wallet.shortfall ?? 0) > 0;
  // Days until the soonest package expires. Their packs are time-boxed, so a
  // large remaining balance can still be about to disappear.
  const daysLeft = account?.expiresAt
    ? Math.max(0, Math.ceil((new Date(account.expiresAt).getTime() - Date.now()) / 86_400_000))
    : null;

  return (
    <div className="rounded-2xl p-5 space-y-4"
      style={{
        background: "var(--bg-card)",
        border: `1px solid ${short ? "oklch(0.6 0.22 25 / 0.35)" : "oklch(0 0 0 / 0.07)"}`,
      }}>
      <div>
        <p className="text-sm font-semibold inline-flex items-center gap-2" style={{ color: "var(--c-85)" }}>
          <Sparkles size={14} style={{ color: "oklch(0.5 0.2 285)" }} />
          GenAIPro video account
        </p>
        <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
          One credit is one clip, and one clip costs $0.02. Top the account up at genaipro.io.
        </p>
      </div>

      {accountError ? (
        <p className="text-xs px-3 py-2 rounded-lg leading-relaxed"
          style={{ background: "oklch(0.6 0.22 25 / 0.1)", color: "oklch(0.5 0.18 25)", border: "1px solid oklch(0.6 0.22 25 / 0.25)" }}>
          {accountError}
        </p>
      ) : account && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Stat label="Available" value={account.remaining.toLocaleString()}
            hint={`$${(account.remaining * 0.02).toFixed(2)} of capacity`} />
          <Stat label="Used" value={account.used.toLocaleString()} hint={`of ${account.quota.toLocaleString()}`} />
          <Stat label="Promised" value={wallet.promised.toLocaleString()}
            hint={`${wallet.promisedPaid.toLocaleString()} of it bought`}
            tone={short ? "oklch(0.55 0.2 25)" : undefined} />
          <Stat label="Expires" value={daysLeft === null ? "—" : `${daysLeft}d`}
            hint={daysLeft !== null && daysLeft <= 2 ? "top up soon" : "soonest package"}
            tone={daysLeft !== null && daysLeft <= 2 ? "oklch(0.55 0.18 65)" : undefined} />
        </div>
      )}

      {short && (
        <p className="text-xs px-3 py-2 rounded-lg leading-relaxed inline-flex items-start gap-2"
          style={{ background: "oklch(0.6 0.22 25 / 0.1)", color: "oklch(0.5 0.18 25)", border: "1px solid oklch(0.6 0.22 25 / 0.25)" }}>
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>
            Customers hold {wallet.shortfall?.toLocaleString()} more credits than this account can serve.
            {wallet.promisedPaid > 0 && " Some of that is credit they paid for."} Top the account up before
            the next render fails.
          </span>
        </p>
      )}

      <p className="text-[11px]" style={{ color: "var(--c-45)" }}>
        {wallet.accounts.toLocaleString()} wallets · {wallet.promisedGrant.toLocaleString()} free credits outstanding
        {wallet.reserved > 0 && ` · ${wallet.reserved.toLocaleString()} reserved by clips rendering now`}
      </p>
    </div>
  );
}
