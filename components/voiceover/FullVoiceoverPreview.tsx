"use client";

import { useEffect, useMemo, useRef, useState } from "react";

// Server-side ffmpeg concat into ONE MP3 — the only way to get a truly
// seamless preview that matches the assembled video's audio track.
// The route at /api/projects/:id/voiceover/concat:
//   1. Hashes the ordered beat URLs (plus a "trim"/"orig" variant
//      suffix so original and trimmed don't collide).
//   2. If a preview file with that hash exists in R2, returns its URL.
//   3. Otherwise downloads each beat, optionally trims silence on every
//      beat, runs ffmpeg `-c copy` concat, uploads the result, returns
//      the URL.
//
// `urlSignature` triggers a rebuild whenever the underlying beat set
// changes. Toggling `trimSilence` triggers a separate fetch (different
// cache key) so both flavors can be displayed side-by-side on the
// assemble page without re-uploading anything between toggles.

export interface VoiceoverPreviewBeat {
  beatNumber: number;
  voiceoverUrl?: string | null;
}

export interface LivePreviewBeat { status?: string; url?: string }

interface Props {
  projectId: string;
  beats: VoiceoverPreviewBeat[];
  liveBeats?: Map<number, LivePreviewBeat>;
  /** When true, the request asks the route to silenceremove each
   *  beat before concat. Two instances on the same page can be
   *  rendered side-by-side for A/B comparison. */
  trimSilence?: boolean;
  /** Override the card heading. Defaults to "Full voiceover preview". */
  title?: string;
  /** Optional caption shown below the title. */
  subtitle?: string;
  /** When provided, the card itself becomes a selection target —
   *  clicking anywhere except the play control calls onSelect. The
   *  play button gets stopPropagation so audio toggling never doubles
   *  as a selection. `selected` controls the active background/border. */
  selected?: boolean;
  onSelect?: () => void;
}

export function FullVoiceoverPreview({
  projectId,
  beats,
  liveBeats,
  trimSilence = false,
  title = "Full voiceover preview",
  subtitle,
  selected = false,
  onSelect,
}: Props) {
  const urlSignature = useMemo(() => {
    const list: string[] = [];
    for (const b of beats) {
      const liveUrl = liveBeats?.get(b.beatNumber)?.url;
      const url = liveUrl ?? b.voiceoverUrl;
      if (url) list.push(`${b.beatNumber}:${url}`);
    }
    return list.sort().join("\n");
  }, [beats, liveBeats]);
  const orderedCount = urlSignature ? urlSignature.split("\n").length : 0;

  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [tickFlag, setTickFlag] = useState(0);
  void tickFlag;
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!urlSignature) { setPreviewUrl(null); return; }
    let cancelled = false;
    setBuilding(true);
    setError(null);
    fetch(`/api/projects/${projectId}/voiceover/concat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trimSilence }),
    })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok) { setError(data.error ?? "Preview build failed"); setPreviewUrl(null); return; }
        setPreviewUrl(data.url);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : "Preview build failed"); })
      .finally(() => { if (!cancelled) setBuilding(false); });
    return () => { cancelled = true; };
  }, [urlSignature, projectId, trimSilence]);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    function onEnded() { setPlaying(false); }
    function onTime() { setTickFlag((t) => t + 1); }
    a.addEventListener("ended", onEnded);
    a.addEventListener("timeupdate", onTime);
    return () => {
      a.removeEventListener("ended", onEnded);
      a.removeEventListener("timeupdate", onTime);
    };
  }, [previewUrl]);

  function toggle() {
    const a = audioRef.current;
    if (!a || !previewUrl) return;
    if (playing) { a.pause(); setPlaying(false); }
    else { a.play().then(() => setPlaying(true)).catch(() => setPlaying(false)); }
  }

  const elapsedSec = audioRef.current?.currentTime ?? 0;
  const totalSec = audioRef.current && isFinite(audioRef.current.duration) ? audioRef.current.duration : 0;
  const pct = totalSec > 0 ? Math.min(100, (elapsedSec / totalSec) * 100) : 0;

  function fmt(s: number): string {
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${r.toString().padStart(2, "0")}`;
  }

  if (orderedCount === 0) return null;
  const canPlay = !!previewUrl && !building;
  const selectable = !!onSelect;

  return (
    <div
      role={selectable ? "button" : undefined}
      tabIndex={selectable ? 0 : undefined}
      aria-pressed={selectable ? selected : undefined}
      onClick={selectable ? onSelect : undefined}
      onKeyDown={selectable ? (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect?.(); }
      } : undefined}
      className={`rounded-2xl p-4 sm:p-5 space-y-3 transition-all ${selectable ? "cursor-pointer" : ""}`}
      style={{
        background: selected ? "oklch(0.72 0.25 285 / 0.12)" : "#ffffff",
        border: `1px solid ${selected ? "oklch(0.72 0.25 285 / 0.5)" : "oklch(0.85 0 0)"}`,
      }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "oklch(0.35 0 0)" }}>
            {title}
          </p>
          {subtitle && (
            <p className="text-[11px] mt-0.5" style={{ color: "oklch(0.45 0 0)" }}>
              {subtitle}
            </p>
          )}
        </div>
        <span className="text-[11px] font-mono tabular-nums shrink-0" style={{ color: "oklch(0.45 0 0)" }}>
          {building ? "Building preview…" : error ? "Failed" : `${orderedCount} beats joined`}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={(e) => { e.stopPropagation(); toggle(); }}
          disabled={!canPlay}
          aria-label={playing ? "Pause" : "Play"}
          className="w-9 h-9 rounded-full flex items-center justify-center transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          style={{ background: "oklch(0.72 0.25 285)", color: "#ffffff" }}
        >
          {playing ? (
            <span className="flex gap-[3px]">
              <span className="block w-[3px] h-3 rounded-sm" style={{ background: "currentColor" }} />
              <span className="block w-[3px] h-3 rounded-sm" style={{ background: "currentColor" }} />
            </span>
          ) : (
            <span
              className="block w-0 h-0 ml-[2px]"
              style={{
                borderLeft: "8px solid currentColor",
                borderTop: "5px solid transparent",
                borderBottom: "5px solid transparent",
              }}
            />
          )}
        </button>
        <div className="flex-1 min-w-0">
          <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "oklch(0.92 0 0)" }}>
            <div
              className="h-full rounded-full transition-all duration-150"
              style={{ width: `${pct}%`, background: "oklch(0.55 0.15 145)" }}
            />
          </div>
          <div className="flex justify-between mt-1 text-[11px] font-mono tabular-nums" style={{ color: "oklch(0.45 0 0)" }}>
            <span>{fmt(elapsedSec)}</span>
            <span>{fmt(totalSec)}</span>
          </div>
        </div>
      </div>
      <audio ref={audioRef} src={previewUrl ?? undefined} preload="auto" />
      {error && (
        <p className="text-[11px]" style={{ color: "oklch(0.7 0.2 25)" }}>{error}</p>
      )}
    </div>
  );
}
