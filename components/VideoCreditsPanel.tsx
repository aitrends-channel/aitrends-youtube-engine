"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Sparkles, Plus } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { startTopUp } from "@/lib/credits-checkout";

// The video-credit balance, shown where clips are generated.
//
// Renders nothing at all when the plan has no allowance and no bought credit.
// That is the Founder exclusion: the surface is absent rather than present and
// unusable, which is also why the check is a server answer (`eligible`) rather
// than a plan string read on the client.
//
// It also completes the top-up: Dodo returns the customer to whichever page
// carries this panel with ?payment_id= on the URL, and the panel hands that to
// the server to confirm and credit. Crediting on the verified return rather
// than a webhook is deliberate — production's Dodo webhook has never worked.

interface CreditsResponse {
  grant: number;
  paid: number;
  total: number;
  reserved: number;
  monthlyGrant: number;
  period: string;
  eligible: boolean;
  setupHint?: string | null;
  pack: { credits: number; priceUsd: number };
  checkoutUrl: string | null;
}

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function VideoCreditsPanel() {
  const { data, mutate, isLoading } = useSWR<CreditsResponse>("/api/credits", fetcher);
  const [claiming, setClaiming] = useState(false);
  // One attempt per payment id per mount: effects run twice in development and
  // the server is idempotent anyway, but there is no reason to ask twice.
  const claimed = useRef<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const paymentId = params.get("payment_id");
    if (!paymentId || claimed.current === paymentId) return;
    claimed.current = paymentId;

    setClaiming(true);
    fetch("/api/credits/topup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payment_id: paymentId }),
    })
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error ?? "Could not confirm that payment");
        if (!body.alreadyCredited) toast.success(`${body.credits} video credits added.`);
        await mutate();
        // Drop the id from the URL so a refresh is not another confirmation.
        params.delete("payment_id");
        const rest = params.toString();
        window.history.replaceState({}, "", window.location.pathname + (rest ? `?${rest}` : ""));
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : "Could not confirm that payment"))
      .finally(() => setClaiming(false));
  }, [mutate]);

  if (isLoading || !data || !data.eligible) return null;

  const { grant, paid, total, reserved, monthlyGrant, pack, checkoutUrl, setupHint } = data;
  const used = Math.max(monthlyGrant - grant, 0);
  const pct = monthlyGrant > 0 ? Math.min(100, Math.round((used / monthlyGrant) * 100)) : 0;
  const empty = total === 0;

  return (
    <div className="rounded-xl px-4 py-3 space-y-2"
      style={{
        background: empty ? "oklch(0.6 0.22 25 / 0.08)" : "var(--bg-progress)",
        border: `1px solid ${empty ? "oklch(0.6 0.22 25 / 0.25)" : "var(--bd-8)"}`,
      }}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-xs font-semibold inline-flex items-center gap-1.5" style={{ color: "var(--c-85)" }}>
            <Sparkles size={13} style={{ color: "var(--brand-text)" }} />
            Video credits
          </p>
          <p className="text-[11px] mt-0.5" style={{ color: "var(--c-50)" }}>
            {/* Stated in clips because that is what a credit buys. A finished
                video is many clips, and the number varies by script length, so
                promising videos here would be a promise we cannot keep. */}
            {total.toLocaleString()} left · one credit per clip
            {reserved > 0 && ` · ${reserved} rendering`}
          </p>
        </div>

        {checkoutUrl && (
          <a
            href={checkoutUrl}
            onClick={(e) => {
              // The redirect_url has to be built here, not in the JSX: window is
              // not available while a client component is prerendered on the
              // server. Without it Dodo keeps the customer on its own receipt.
              e.preventDefault();
              startTopUp(checkoutUrl);
            }}
            className="inline-flex items-center gap-1.5 shrink-0 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90"
            style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
          >
            {claiming ? <Spinner size={12} /> : <Plus size={12} />}
            {claiming ? "Confirming…" : `Top up ${pack.credits} for $${pack.priceUsd}`}
          </a>
        )}
      </div>

      {monthlyGrant > 0 && (
        <div className="space-y-1">
          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "oklch(0 0 0 / 0.12)" }}>
            <div className="h-full rounded-full transition-all"
              style={{ width: `${pct}%`, background: pct >= 100 ? "oklch(0.6 0.22 25)" : "oklch(0.72 0.25 285)" }} />
          </div>
          <p className="text-[10px]" style={{ color: "var(--c-45)" }}>
            {grant.toLocaleString()} of this month&apos;s {monthlyGrant.toLocaleString()} free credits left
            {paid > 0 && ` · ${paid.toLocaleString()} bought credits, which do not expire`}
          </p>
        </div>
      )}

      {setupHint && (
        <p className="text-[11px] leading-relaxed" style={{ color: "var(--accent-amber-text)" }}>
          {setupHint}
        </p>
      )}

      {empty && (
        <p className="text-[11px] leading-relaxed" style={{ color: "oklch(0.7 0.2 25)" }}>
          You have no credits left. Free credits refresh at the start of next month, or top up to keep generating now.
        </p>
      )}
    </div>
  );
}
