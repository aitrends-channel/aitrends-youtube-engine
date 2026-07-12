"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

// Compact custom audio player for a single beat's voiceover clip.
// Replaces the browser's native <audio controls> (which renders
// inconsistently across browsers and clashes with the app's theme) with
// a themed play/pause button, a seekable progress bar, a time readout,
// and a ⋮ menu that restores the native player's Download + playback-
// speed options. Purely client-side — streams the R2-hosted mp3 directly.
export function BeatAudioPlayer({ src, beatNumber }: { src: string; beatNumber?: number }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const menuWrapRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState(1);
  const [menuOpen, setMenuOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => setCurrent(a.currentTime);
    const onDur = () => setDuration(isFinite(a.duration) ? a.duration : 0);
    const onEnd = () => { setPlaying(false); setCurrent(0); };
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    a.addEventListener("timeupdate", onTime);
    a.addEventListener("loadedmetadata", onDur);
    a.addEventListener("durationchange", onDur);
    a.addEventListener("ended", onEnd);
    a.addEventListener("play", onPlay);
    a.addEventListener("pause", onPause);
    return () => {
      a.removeEventListener("timeupdate", onTime);
      a.removeEventListener("loadedmetadata", onDur);
      a.removeEventListener("durationchange", onDur);
      a.removeEventListener("ended", onEnd);
      a.removeEventListener("play", onPlay);
      a.removeEventListener("pause", onPause);
    };
  }, []);

  // A changed src attribute doesn't reload the element on its own — force
  // it so a regenerated clip plays the new audio, not the buffered old.
  // Re-apply the chosen playback rate (load() resets it to 1). Keyed on
  // `src` ONLY: reloading on every rate change would interrupt an
  // in-flight play() (the classic "the play() request was interrupted by
  // a call to load()" error) and stop playback mid-clip on mobile.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    a.load();
    a.playbackRate = rate;
    setPlaying(false);
    setCurrent(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // Apply playback-rate changes live without reloading the element.
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = rate;
  }, [rate]);

  // Close the ⋮ menu on any outside click.
  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(e: MouseEvent) {
      if (menuWrapRef.current && !menuWrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  function toggle() {
    const a = audioRef.current;
    if (!a) return;
    if (playing) {
      a.pause();
      return;
    }
    // play() is called synchronously inside the click gesture so mobile
    // autoplay policies allow it. Surface failures instead of swallowing
    // them — a silent catch is why a failed tap looked like "nothing
    // happens" on mobile.
    a.play().catch((err) => {
      console.warn("Beat audio playback failed", err);
      toast.error("Couldn't play this clip — tap play again.");
    });
  }

  function seek(e: React.MouseEvent<HTMLDivElement>) {
    const a = audioRef.current;
    if (!a || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    a.currentTime = frac * duration;
    setCurrent(a.currentTime);
  }

  function applyRate(r: number) {
    setRate(r);
    if (audioRef.current) audioRef.current.playbackRate = r;
    setMenuOpen(false);
  }

  async function download() {
    setMenuOpen(false);
    const name = `beat-${beatNumber ?? "voiceover"}.mp3`;
    try {
      setDownloading(true);
      // Fetch to a blob so the browser saves the file rather than
      // navigating to it (cross-origin `download` attrs are ignored).
      const res = await fetch(src);
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
      // CORS/network fallback: open in a new tab so the user can save.
      window.open(src, "_blank", "noopener");
    } finally {
      setDownloading(false);
    }
  }

  const pct = duration > 0 ? (current / duration) * 100 : 0;
  const fmt = (s: number) => {
    if (!isFinite(s) || s < 0) return "0:00";
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  return (
    <div
      className="flex items-center gap-2 rounded-xl px-2 py-1.5"
      style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-8)" }}
    >
      <button
        onClick={toggle}
        aria-label={playing ? "Pause" : "Play"}
        className="w-7 h-7 rounded-full flex items-center justify-center shrink-0 transition-transform hover:scale-105"
        style={{ background: "oklch(0.72 0.25 285)", color: "#fff" }}
      >
        {playing ? (
          <span className="flex gap-[2px]">
            <span className="block w-[2.5px] h-2.5 rounded-sm" style={{ background: "currentColor" }} />
            <span className="block w-[2.5px] h-2.5 rounded-sm" style={{ background: "currentColor" }} />
          </span>
        ) : (
          <span
            className="block w-0 h-0 ml-[2px]"
            style={{
              borderLeft: "7px solid currentColor",
              borderTop: "4px solid transparent",
              borderBottom: "4px solid transparent",
            }}
          />
        )}
      </button>
      <div
        className="flex-1 min-w-0 h-1.5 rounded-full overflow-hidden cursor-pointer"
        style={{ background: "var(--bg-track)" }}
        onClick={seek}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(current)}
      >
        <div
          className="h-full rounded-full transition-[width] duration-150"
          style={{ width: `${pct}%`, background: "oklch(0.72 0.25 285)" }}
        />
      </div>
      <span className="text-[10px] font-mono tabular-nums shrink-0" style={{ color: "var(--c-45)" }}>
        {fmt(current)} / {fmt(duration)}
      </span>

      {/* ⋮ menu — download + playback speed (restores the native menu). */}
      <div ref={menuWrapRef} className="relative shrink-0">
        <button
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="More options"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          className="w-6 h-7 rounded-md flex items-center justify-center transition-colors hover:bg-[var(--bg-track)]"
          style={{ color: "var(--c-50)" }}
        >
          <span className="flex flex-col gap-[2px]">
            <span className="block w-[3px] h-[3px] rounded-full" style={{ background: "currentColor" }} />
            <span className="block w-[3px] h-[3px] rounded-full" style={{ background: "currentColor" }} />
            <span className="block w-[3px] h-[3px] rounded-full" style={{ background: "currentColor" }} />
          </span>
        </button>
        {menuOpen && (
          <div
            role="menu"
            className="absolute right-0 top-full mt-1 z-50 rounded-lg py-1 shadow-xl"
            style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-8)", minWidth: 150 }}
          >
            <button
              role="menuitem"
              onClick={download}
              disabled={downloading}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left transition-colors hover:bg-[var(--bg-track)] disabled:opacity-50"
              style={{ color: "var(--c-75)" }}
            >
              <svg width="12" height="12" viewBox="0 0 14 14" fill="none" aria-hidden>
                <path d="M7 1v8m0 0L4 6m3 3l3-3M2 12h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {downloading ? "Downloading…" : "Download"}
            </button>
            <div className="my-1 h-px" style={{ background: "var(--bd-8)" }} />
            <p className="px-3 pt-0.5 pb-1 text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>
              Playback speed
            </p>
            {SPEEDS.map((s) => (
              <button
                key={s}
                role="menuitemradio"
                aria-checked={rate === s}
                onClick={() => applyRate(s)}
                className="w-full flex items-center justify-between px-3 py-1 text-xs text-left transition-colors hover:bg-[var(--bg-track)]"
                style={{ color: rate === s ? "oklch(0.72 0.25 285)" : "var(--c-70)" }}
              >
                {s === 1 ? "Normal" : `${s}×`}
                {rate === s && (
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden>
                    <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      <audio ref={audioRef} src={src} preload="metadata" />
    </div>
  );
}
