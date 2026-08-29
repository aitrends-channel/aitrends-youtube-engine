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
  /** Fires every time the loading state flips. Lets the parent show a
   *  combined loading indicator while either preview is still building
   *  on the server or downloading audio in the browser. */
  onLoadingChange?: (loading: boolean) => void;
  /** Optional background music — when provided, the card surfaces a
   *  music chip + on/off toggle. When the toggle is on, the music
   *  plays in sync with the voiceover (start, seek, pause, end all
   *  mirrored to a second audio element). bgmUrl can be a blob: URL
   *  from a local File so previews work before any server upload.
   *  bgmVolume is the 0–1 multiplier applied to the bgm audio (same
   *  value sent to the worker at assembly time). */
  bgmUrl?: string | null;
  bgmName?: string;
  bgmVolume?: number;
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
  onLoadingChange,
  bgmUrl,
  bgmName,
  bgmVolume = 0.15,
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
  // Start true so isLoading is true on the very first render — the
  // fetch useEffect always runs on mount and either kicks off the
  // request (keeping this true) or clears it immediately (no urls).
  // Without this, the loading UI flickers off for one frame before
  // the effect re-sets it, which the parent indicator also misses.
  const [building, setBuilding] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [tickFlag, setTickFlag] = useState(0);
  void tickFlag;
  // Duration in state (not derived from audioRef.current.duration on
  // each render) — the audio element loads metadata async, and without
  // a loadedmetadata listener the component never re-renders to pick
  // up the real value. That made the two cards display "0:00" until
  // played, which read as "equal length".
  const [duration, setDuration] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Background-music audio element + per-card "play with preview"
  // toggle. Defaults on whenever a bgm is attached. Volume + currentTime
  // get kept in sync with the main audio in toggle()/seek() and the
  // onEnded handler so the two streams stay locked together. The pair
  // can drift by a frame or two during play() — acceptable for music
  // bedding; sub-100ms is inaudible against narration.
  const bgmAudioRef = useRef<HTMLAudioElement | null>(null);
  const [bgmPlayWithPreview, setBgmPlayWithPreview] = useState<boolean>(true);
  // Tracks whether the bgm element is currently sounding — drives the
  // standalone "play music only" button's icon.
  const [bgmPlaying, setBgmPlaying] = useState(false);
  // When the toggle flips OFF mid-playback, pause the bgm immediately
  // even if the voiceover keeps going. Also keep volume in sync if the
  // parent changes it via the slider.
  useEffect(() => {
    const bgm = bgmAudioRef.current;
    if (!bgm) return;
    bgm.volume = Math.max(0, Math.min(1, bgmVolume));
    if (!bgmPlayWithPreview || !bgmUrl) {
      try { bgm.pause(); } catch { /* ignore */ }
      bgm.currentTime = 0;
    }
  }, [bgmPlayWithPreview, bgmUrl, bgmVolume]);

  useEffect(() => {
    if (!urlSignature) { setPreviewUrl(null); setBuilding(false); return; }
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
    function onEnded() {
      setPlaying(false);
      // Stop bgm at the same moment so it doesn't run past the end
      // of the narration.
      const bgm = bgmAudioRef.current;
      if (bgm) { try { bgm.pause(); } catch { /* ignore */ } bgm.currentTime = 0; }
    }
    function onTime() { setTickFlag((t) => t + 1); }
    function onMeta() {
      if (a && isFinite(a.duration)) setDuration(a.duration);
    }
    // Without this, a failed audio load (r2.dev 429, expired URL,
    // network drop) left duration at 0 forever and the card stuck on
    // "Loading audio…" with no way to tell anything went wrong.
    function onError() {
      setError("Audio failed to load — try again in a moment");
    }
    setDuration(0);
    if (isFinite(a.duration) && a.duration > 0) setDuration(a.duration);
    a.addEventListener("ended", onEnded);
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onMeta);
    a.addEventListener("durationchange", onMeta);
    a.addEventListener("error", onError);
    return () => {
      a.removeEventListener("ended", onEnded);
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("loadedmetadata", onMeta);
      a.removeEventListener("durationchange", onMeta);
      a.removeEventListener("error", onError);
    };
  }, [previewUrl]);

  function toggle() {
    const a = audioRef.current;
    if (!a || !previewUrl) return;
    if (playing) {
      a.pause();
      // Mirror to bgm so background music stops together.
      const bgm = bgmAudioRef.current;
      if (bgm) { try { bgm.pause(); } catch { /* ignore */ } }
      setPlaying(false);
    } else {
      a.play().then(() => {
        setPlaying(true);
        // Start bgm at the same offset so the music doesn't restart
        // from zero if the user paused/resumed.
        const bgm = bgmAudioRef.current;
        if (bgm && bgmPlayWithPreview && bgmUrl) {
          try {
            bgm.currentTime = a.currentTime;
            bgm.volume = Math.max(0, Math.min(1, bgmVolume));
            void bgm.play().catch(() => { /* autoplay restrictions OK to swallow */ });
          } catch { /* ignore */ }
        }
      }).catch(() => setPlaying(false));
    }
  }

  function seek(nextSec: number) {
    const a = audioRef.current;
    if (!a || !isFinite(nextSec)) return;
    const clamped = Math.max(0, Math.min(duration || 0, nextSec));
    a.currentTime = clamped;
    // Keep bgm aligned on scrub.
    const bgm = bgmAudioRef.current;
    if (bgm) bgm.currentTime = clamped;
    setTickFlag((t) => t + 1);
  }

  // Export the built concat MP3. Fetch to a blob so the browser saves
  // it (cross-origin `download` attrs are ignored); fall back to opening
  // the URL if R2 CORS blocks the GET. Filename derives from the card
  // title so "Trimmed voiceover" and "Original voiceover" export
  // distinctly.
  async function download(e: React.MouseEvent) {
    e.stopPropagation();
    if (!previewUrl) return;
    const slug = (title || "voiceover").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const name = `${slug || "voiceover"}.mp3`;
    try {
      setDownloading(true);
      const res = await fetch(previewUrl);
      if (!res.ok) throw new Error(String(res.status));
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
    } catch {
      window.open(previewUrl, "_blank", "noopener");
    } finally {
      setDownloading(false);
    }
  }

  const elapsedSec = audioRef.current?.currentTime ?? 0;
  const totalSec = duration;
  const pct = totalSec > 0 ? Math.min(100, (elapsedSec / totalSec) * 100) : 0;

  function fmt(s: number): string {
    if (!isFinite(s) || s <= 0) return "0:00";
    const m = Math.floor(s / 60);
    const r = s % 60;
    // One decimal so small trim deltas (e.g. 1:23.4 vs 1:21.7) are
    // visible — otherwise floor-to-second display can hide a ~1s diff.
    return `${m}:${r.toFixed(1).padStart(4, "0")}`;
  }

  if (orderedCount === 0) return null;
  // "Loading" covers both stages the user perceives as a wait:
  //   1. server build/cache lookup of the concat URL (`building`)
  //   2. browser still downloading + parsing audio metadata so we
  //      don't know the duration yet (URL set but duration still 0)
  // Without #2 the loading flash disappears after ~100ms on warm
  // cache, then the slider renders with totalSec=0 for the rest of
  // the audio-element load — looks like the loader never appeared.
  const isLoading = building || (!!previewUrl && duration <= 0 && !error);
  const canPlay = !!previewUrl && !isLoading;
  const selectable = !!onSelect;

  // Surface loading state to the parent so it can render its own
  // combined indicator (e.g. under the Voiceover Source heading).
  useEffect(() => {
    onLoadingChange?.(isLoading);
  }, [isLoading, onLoadingChange]);

  return (
    <div
      role={selectable ? "button" : undefined}
      tabIndex={selectable ? 0 : undefined}
      aria-pressed={selectable ? selected : undefined}
      onClick={selectable ? onSelect : undefined}
      onKeyDown={selectable ? (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect?.(); }
      } : undefined}
      className={`rounded-2xl px-4 py-3 space-y-2 transition-all ${selectable ? "cursor-pointer" : ""}`}
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
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] font-mono tabular-nums" style={{ color: "oklch(0.45 0 0)" }}>
            {isLoading ? (building ? "Building preview…" : "Loading audio…") : error ? "Failed" : `${orderedCount} beats joined`}
          </span>
          {/* Export the built MP3 — one button per card so the user can
              save the trimmed and original voiceovers separately. */}
          <button
            onClick={download}
            disabled={!canPlay || downloading}
            title={`Export ${title}`}
            aria-label={`Export ${title}`}
            className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium transition-opacity hover:opacity-90 disabled:opacity-40"
            style={{ background: "oklch(0.72 0.25 285 / 0.12)", color: "var(--brand-text)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}
          >
            <svg width="11" height="11" viewBox="0 0 14 14" fill="none" aria-hidden>
              <path d="M7 1v8m0 0L4 6m3 3l3-3M2 12h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {downloading ? "Exporting…" : "Export"}
          </button>
        </div>
      </div>
      <div className="flex items-center gap-2.5">
        <button
          onClick={(e) => { e.stopPropagation(); toggle(); }}
          disabled={!canPlay}
          aria-label={isLoading ? "Loading preview" : playing ? "Pause" : "Play"}
          aria-busy={isLoading}
          className="w-8 h-8 rounded-full flex items-center justify-center transition-opacity hover:opacity-90 disabled:opacity-60 disabled:cursor-not-allowed shrink-0"
          style={{ background: "oklch(0.72 0.25 285)", color: "#ffffff" }}
        >
          {isLoading ? (
            <span className="block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
          ) : playing ? (
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
          {/* While loading, show a shimmer skeleton in place of the
              slider — the same height + rounding so the layout doesn't
              jump when the real slider takes over. */}
          {isLoading ? (
            <div
              className="h-1.5 rounded-full shimmer"
              style={{ background: "oklch(0.92 0 0)" }}
              aria-hidden="true"
            />
          ) : (
          /* Seek slider — native range input styled to look like the
              progress bar. Gradient on the track gives the filled-in
              segment up to `pct`; the thumb is the draggable handle.
              Input handlers stop propagation so dragging the slider on
              a selectable card doesn't toggle the selection. */
          <input
            type="range"
            min={0}
            max={totalSec || 0}
            step={0.01}
            value={Math.min(elapsedSec, totalSec || 0)}
            disabled={!canPlay || totalSec <= 0}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onTouchStart={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            onChange={(e) => seek(parseFloat(e.target.value))}
            aria-label="Seek"
            className="seek-slider w-full"
            style={{
              background: `linear-gradient(to right, oklch(0.55 0.15 145) 0%, oklch(0.55 0.15 145) ${pct}%, oklch(0.92 0 0) ${pct}%, oklch(0.92 0 0) 100%)`,
            }}
          />
          )}
          <div className="flex justify-between mt-0.5 text-[11px] font-mono tabular-nums" style={{ color: "oklch(0.45 0 0)" }}>
            <span>{fmt(elapsedSec)}</span>
            <span>{isLoading ? "—:——" : fmt(totalSec)}</span>
          </div>
        </div>
      </div>
      <audio ref={audioRef} src={previewUrl ?? undefined} preload="auto" />
      {/* Background-music chip + toggle. Shows only when a bgm is
          attached at the page level. The toggle is per-card so users
          can A/B compare "voice only" vs "voice + music" between the
          Trimmed and Original previews. Clicks stopPropagation so
          interacting on a selectable card doesn't double as a
          selection toggle. */}
      {bgmUrl && (
        <>
          {/* loop=true so a short music file fills the entire
              voiceover duration instead of ending mid-narration.
              The voiceover's `ended` event still gates the bgm pause
              so it never plays past the end. */}
          <audio
            ref={bgmAudioRef}
            src={bgmUrl}
            preload="auto"
            loop={true}
            onPlay={() => setBgmPlaying(true)}
            onPause={() => setBgmPlaying(false)}
          />
          <div
            className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5"
            onClick={(e) => e.stopPropagation()}
            style={{ background: "oklch(0.96 0 0)", border: "1px solid oklch(0.85 0 0)" }}
          >
            <div className="flex items-center gap-2 min-w-0">
              {/* Play ONLY the background music — pauses the voiceover so
                  the user can audition the track by itself. */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  const bgm = bgmAudioRef.current;
                  if (!bgm) return;
                  if (bgm.paused) {
                    const a = audioRef.current;
                    if (a && !a.paused) { a.pause(); setPlaying(false); }
                    bgm.volume = Math.max(0, Math.min(1, bgmVolume));
                    void bgm.play().catch(() => {});
                  } else {
                    bgm.pause();
                  }
                }}
                aria-label={bgmPlaying ? "Pause music" : "Play music only"}
                title={bgmPlaying ? "Pause music" : "Play music only"}
                className="w-6 h-6 rounded-full flex items-center justify-center shrink-0 transition-transform hover:scale-105"
                style={{ background: "oklch(0.72 0.25 285)", color: "#fff" }}
              >
                {bgmPlaying ? (
                  <span className="flex gap-[2px]">
                    <span className="block w-[2px] h-2 rounded-sm" style={{ background: "currentColor" }} />
                    <span className="block w-[2px] h-2 rounded-sm" style={{ background: "currentColor" }} />
                  </span>
                ) : (
                  <span
                    className="block w-0 h-0 ml-[1px]"
                    style={{ borderLeft: "6px solid currentColor", borderTop: "4px solid transparent", borderBottom: "4px solid transparent" }}
                  />
                )}
              </button>
              <span className="text-[11px] truncate" style={{ color: "oklch(0.4 0 0)" }}
                title={bgmName ?? "Background music"}>
                {bgmName ?? "Background music"}
              </span>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); setBgmPlayWithPreview((v) => !v); }}
              aria-label={bgmPlayWithPreview ? "Disable music in preview" : "Enable music in preview"}
              title={bgmPlayWithPreview ? "Music plays with preview" : "Music muted in preview"}
              className="relative w-9 h-5 rounded-full transition-all shrink-0"
              style={{
                background: bgmPlayWithPreview ? "oklch(0.72 0.25 285)" : "oklch(0.82 0 0)",
                border: "1px solid oklch(0.75 0 0)",
              }}
            >
              <span
                className="absolute top-0.5 w-4 h-4 rounded-full transition-all"
                style={{
                  background: "#ffffff",
                  left: bgmPlayWithPreview ? "calc(100% - 1.125rem)" : "0.125rem",
                }}
              />
            </button>
          </div>
        </>
      )}
      {error && (
        <p className="text-[11px]" style={{ color: "oklch(0.7 0.2 25)" }}>{error}</p>
      )}
    </div>
  );
}
