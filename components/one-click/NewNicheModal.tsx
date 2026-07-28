"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Wand2, ArrowRight, AlertTriangle } from "lucide-react";
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

const CONTENT_TYPES = [
  { value: "long" as const, label: "Long-form", desc: "Standard landscape videos." },
  { value: "shorts" as const, label: "Shorts", desc: "Vertical short-form clips." },
  { value: "both" as const, label: "Both", desc: "Mix of long-form and shorts." },
];

// Everything 1Click needs to start a brand-new niche: which content type to
// model, and the channel to learn the style from. Shown on the 1Click view
// so the whole flow stays in one place rather than routing through the
// wizard's channel step.
//
// Keeps the channel step's two guards, which both cost the user real money
// if skipped: the duplicate-niche check (a second niche for the same
// channel burns a plan slot and re-runs analysis for nothing) and the
// long-channel consent gate (45min+ averages degrade the pipeline).
export function NewNicheModal({
  onReady,
}: {
  /** Called with a validated channel once the user confirms. */
  onReady: (v: { channelUrl: string; contentType: "long" | "shorts" | "both"; info: KickoffChannelInfo }) => void;
}) {
  const router = useRouter();
  const [contentType, setContentType] = useState<"long" | "shorts" | "both" | null>(null);
  const [channelUrl, setChannelUrl] = useState("");
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{ id: string; channelName: string } | null>(null);
  const [longConsent, setLongConsent] = useState<{ avgSeconds: number; info: KickoffChannelInfo } | null>(null);

  const canSubmit = Boolean(contentType && channelUrl.trim()) && !checking;

  async function submit() {
    if (!contentType || !channelUrl.trim()) return;
    setChecking(true);
    setError(null);
    try {
      const info = await fetchChannelInfo(channelUrl.trim(), contentType);
      const existing = await findExistingNiche(info.channelName);
      if (existing) { setDuplicate(existing); return; }
      const avg = averageDurationSeconds(info.topVideos ?? []);
      if (needsLongVideoConsent(avg) && avg != null) {
        setLongConsent({ avgSeconds: avg, info });
        return;
      }
      onReady({ channelUrl: channelUrl.trim(), contentType, info });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't read that channel");
    } finally {
      setChecking(false);
    }
  }

  // ── Duplicate niche ────────────────────────────────────────────────────
  if (duplicate) {
    return (
      <Panel title="You already have this niche">
        <p className="text-sm leading-relaxed" style={{ color: "var(--c-70)" }}>
          A niche for <strong>{duplicate.channelName}</strong> already exists. Add a new video to it
          instead of creating a duplicate: it keeps your niche slot and reuses the analysis you already paid for.
        </p>
        <div className="grid gap-2 mt-1">
          <PrimaryButton onClick={() => router.push("/dashboard")}>Go to that niche</PrimaryButton>
          <GhostButton onClick={() => { setDuplicate(null); setChannelUrl(""); }}>Try another channel</GhostButton>
        </div>
      </Panel>
    );
  }

  // ── Long-channel consent ───────────────────────────────────────────────
  if (longConsent) {
    return (
      <Panel title="This channel's videos are long" icon="warn">
        <p className="text-sm leading-relaxed" style={{ color: "var(--c-70)" }}>
          Average video length is about <strong>{formatSecondsAsHHMMSS(longConsent.avgSeconds)}</strong>.
          We analyse a smaller sample of videos for channels this long, so the style match may be less precise.
        </p>
        <div className="grid gap-2 mt-1">
          <PrimaryButton
            onClick={() => {
              const { info } = longConsent;
              setLongConsent(null);
              onReady({ channelUrl: channelUrl.trim(), contentType: contentType!, info });
            }}
          >
            Continue anyway
          </PrimaryButton>
          <GhostButton onClick={() => setLongConsent(null)}>Pick a different channel</GhostButton>
        </div>
      </Panel>
    );
  }

  // ── Collect content type + channel ─────────────────────────────────────
  return (
    <Panel title="Start a new niche with 1Click">
      <p className="text-sm leading-relaxed" style={{ color: "var(--c-55)" }}>
        Tell us what kind of videos you make and the channel to model the style on. 1Click takes it from there.
      </p>

      <div className="space-y-2">
        <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-45)" }}>
          Content type
        </p>
        <div className="grid gap-2">
          {CONTENT_TYPES.map((t) => {
            const active = contentType === t.value;
            return (
              <button
                key={t.value}
                type="button"
                onClick={() => setContentType(t.value)}
                className="w-full text-left px-3.5 py-2.5 rounded-xl transition-all hover:opacity-90"
                style={active
                  ? { background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.45)" }
                  : { background: "var(--bg-input)", border: "1px solid var(--bd-card)" }}
              >
                <span className="block text-sm font-semibold"
                  style={{ color: active ? "oklch(0.88 0.12 285)" : "var(--c-90)" }}>
                  {t.label}
                </span>
                <span className="block text-xs mt-0.5" style={{ color: "var(--c-50)" }}>{t.desc}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-2">
        <label className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-45)" }}>
          YouTube channel
        </label>
        <input
          type="url"
          value={channelUrl}
          onChange={(e) => { setChannelUrl(e.target.value); setError(null); }}
          onKeyDown={(e) => { if (e.key === "Enter" && canSubmit) void submit(); }}
          placeholder="https://youtube.com/@channel"
          className="w-full px-3.5 py-2.5 rounded-xl text-sm outline-none transition-all"
          style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)", color: "var(--c-90)" }}
        />
      </div>

      {error && (
        <p className="text-xs px-3 py-2 rounded-lg"
          style={{ background: "oklch(0.6 0.22 25 / 0.1)", color: "oklch(0.7 0.2 25)", border: "1px solid oklch(0.6 0.22 25 / 0.2)" }}>
          {error}
        </p>
      )}

      <PrimaryButton onClick={submit} disabled={!canSubmit}>
        {checking ? (<><Spinner size={13} /> Reading channel…</>) : (<>Continue <ArrowRight size={14} /></>)}
      </PrimaryButton>
    </Panel>
  );
}

function Panel({ title, icon, children }: { title: string; icon?: "warn"; children: React.ReactNode }) {
  return (
    <div className="max-w-md mx-auto rounded-2xl p-5 sm:p-6 space-y-4"
      style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)", boxShadow: "0 12px 40px oklch(0 0 0 / 0.35)" }}>
      <div className="flex items-center gap-2.5">
        <span className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
          {icon === "warn"
            ? <AlertTriangle size={17} style={{ color: "oklch(0.7 0.18 65)" }} />
            : <Wand2 size={17} style={{ color: "oklch(0.72 0.25 285)" }} />}
        </span>
        <h2 className="text-base font-bold" style={{ color: "var(--c-90)" }}>{title}</h2>
      </div>
      {children}
    </div>
  );
}

function PrimaryButton({ onClick, disabled, children }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full inline-flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-40 cursor-pointer"
      style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
    >
      {children}
    </button>
  );
}

function GhostButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full py-2.5 rounded-xl text-sm font-medium transition-colors hover:opacity-80 cursor-pointer"
      style={{ color: "var(--c-55)" }}
    >
      {children}
    </button>
  );
}
