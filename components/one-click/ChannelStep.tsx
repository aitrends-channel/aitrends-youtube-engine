"use client";

import { useState, type ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import {
  fetchChannelInfo,
  findExistingNiche,
  type KickoffChannelInfo,
} from "@/lib/one-click/kickoff";
import {
  averageDurationSeconds,
  needsLongVideoConsent,
  formatSecondsAsHHMMSS,
} from "@/lib/youtube/duration";

export type ContentType = "long" | "shorts" | "both";

export interface ChannelPlan {
  channelUrl: string;
  info: KickoffChannelInfo;
}

/** Collects just the channel URL for a new niche. Content type is not asked
 *  here — it lives in the saved 1Click config (screen 1 of setup), so a
 *  configured user only ever supplies a channel.
 *
 *  resolve() does the work that has to succeed before a run can start: look
 *  the channel up, refuse a duplicate niche, and get consent for a
 *  long-average channel. Both guards cost the user real money if skipped —
 *  a duplicate burns a plan slot and re-runs analysis, and 45min+ averages
 *  degrade the pipeline.
 */
export function useChannelUrl(contentType: ContentType) {
  const [channelUrl, setChannelUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{ id: string; channelName: string } | null>(null);
  // Resolver pattern: resolve() parks on this promise while the user answers,
  // the same way the wizard's channel step handles the gate.
  const [consent, setConsent] = useState<{ avgSeconds: number; resolve: (ok: boolean) => void } | null>(null);

  const ready = Boolean(channelUrl.trim()) && !busy && !duplicate;

  /** Returns a validated plan, or null if the user has to fix something. */
  async function resolve(): Promise<ChannelPlan | null> {
    const url = channelUrl.trim();
    if (!url) return null;
    setBusy(true);
    setError(null);
    try {
      const info = await fetchChannelInfo(url, contentType);
      const existing = await findExistingNiche(info.channelName);
      if (existing) { setDuplicate(existing); return null; }

      const avg = averageDurationSeconds(info.topVideos ?? []);
      if (needsLongVideoConsent(avg) && avg != null) {
        const ok = await new Promise<boolean>((r) => setConsent({ avgSeconds: avg, resolve: r }));
        setConsent(null);
        if (!ok) return null;
      }
      return { channelUrl: url, info };
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read that channel");
      return null;
    } finally {
      setBusy(false);
    }
  }

  const node: ReactNode = (
    <div className="space-y-3">
      <input
        type="url"
        value={channelUrl}
        onChange={(e) => { setChannelUrl(e.target.value); setError(null); setDuplicate(null); }}
        placeholder="https://youtube.com/@channel"
        autoFocus
        className="w-full px-3.5 py-2.5 rounded-xl text-sm outline-none transition-all"
        style={{ background: "var(--bg-input)", border: "1px solid var(--bd-10)", color: "var(--c-90)" }}
      />
      {busy && (
        <p className="text-xs inline-flex items-center gap-2" style={{ color: "var(--c-45)" }}>
          <Spinner size={12} /> Reading the channel…
        </p>
      )}
      {error && (
        <p className="text-xs px-3 py-2 rounded-lg"
          style={{ background: "oklch(0.6 0.22 25 / 0.1)", color: "oklch(0.7 0.2 25)", border: "1px solid oklch(0.6 0.22 25 / 0.2)" }}>
          {error}
        </p>
      )}

      {/* Duplicate niche — a hard stop, not a warning. */}
      {duplicate && (
        <div className="rounded-xl px-4 py-3 space-y-1.5"
          style={{ background: "oklch(0.6 0.22 25 / 0.1)", border: "1px solid oklch(0.6 0.22 25 / 0.25)" }}>
          <p className="text-sm font-semibold" style={{ color: "oklch(0.7 0.2 25)" }}>
            You already have this niche
          </p>
          <p className="text-xs leading-relaxed" style={{ color: "var(--c-70)" }}>
            A niche for <strong>{duplicate.channelName}</strong> exists already. Add a new video to it from your
            dashboard instead: that keeps your niche slot and reuses the analysis you already paid for.
          </p>
        </div>
      )}

      {/* Long-channel consent — resolve() is parked awaiting this answer. */}
      {consent && (
        <div className="rounded-xl px-4 py-3 space-y-2"
          style={{ background: "oklch(0.72 0.18 65 / 0.1)", border: "1px solid oklch(0.72 0.18 65 / 0.3)" }}>
          <p className="text-sm font-semibold inline-flex items-center gap-2" style={{ color: "var(--accent-amber-text)" }}>
            <AlertTriangle size={14} /> These videos are long
          </p>
          <p className="text-xs leading-relaxed" style={{ color: "var(--c-70)" }}>
            The channel averages about <strong>{formatSecondsAsHHMMSS(consent.avgSeconds)}</strong> per video. We
            analyse a smaller sample at that length, so the style match may be less precise.
          </p>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => consent.resolve(true)}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer"
              style={{ background: "oklch(0.72 0.25 285)", color: "white" }}>
              Continue anyway
            </button>
            <button type="button" onClick={() => consent.resolve(false)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer"
              style={{ color: "var(--c-55)" }}>
              Pick another channel
            </button>
          </div>
        </div>
      )}
    </div>
  );

  return { node, ready, resolve };
}
