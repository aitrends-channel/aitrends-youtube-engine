"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { VoiceoverPreviewBeat, LivePreviewBeat } from "./FullVoiceoverPreview";

// Client-side end-to-end preview for the voiceover step: plays the
// per-beat mp3s in beat order from one <audio> element, advancing on
// `ended`. The beats are already on the page (each has its own player)
// so gluing them server-side just to listen was pure waste — the old
// FullVoiceoverPreview here POSTed /voiceover/concat on every finished
// beat during generation: a full rebuild (download every completed
// beat, ffmpeg concat, upload) per beat, O(N²) R2 reads for previews
// nobody was playing. This player costs zero server work and only
// streams what the user actually listens to.
//
// The assemble page still uses FullVoiceoverPreview: its trim-silence
// A/B compare genuinely needs the server-side ffmpeg pass, and its
// beat set is stable so one build per variant is fine.
//
// Beats that finish while this is playing simply join the queue — the
// ordered list is recomputed from props, so `ended` on the last known
// beat picks up anything that completed since playback started.

interface Props {
  beats: VoiceoverPreviewBeat[];
  liveBeats?: Map<number, LivePreviewBeat>;
}

export function SequentialVoiceoverPreview({ beats, liveBeats }: Props) {
  const ordered = useMemo(() => {
    const list: { beatNumber: number; url: string }[] = [];
    for (const b of beats) {
      const liveUrl = liveBeats?.get(b.beatNumber)?.url;
      const url = liveUrl ?? b.voiceoverUrl;
      if (url) list.push({ beatNumber: b.beatNumber, url });
    }
    list.sort((a, b) => a.beatNumber - b.beatNumber);
    return list;
  }, [beats, liveBeats]);
  const totalBeats = beats.length;
  const readyCount = ordered.length;

  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [tickFlag, setTickFlag] = useState(0);
  void tickFlag;
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Warms the browser cache for the next beat so the ended→next swap
  // is near-gapless. Held in a ref so the element isn't GC'd while
  // buffering.
  const prefetchRef = useRef<HTMLAudioElement | null>(null);

  const current = ordered[Math.min(idx, Math.max(0, readyCount - 1))] ?? null;

  useEffect(() => {
    const next = ordered[idx + 1];
    if (!next) { prefetchRef.current = null; return; }
    const pre = new Audio();
    pre.preload = "auto";
    pre.src = next.url;
    prefetchRef.current = pre;
  }, [idx, ordered]);

  // Advance/end/error handling. `playing` staying true across an
  // advance is what makes the play() effect below auto-continue.
  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    function advance() {
      setIdx((i) => {
        if (i + 1 < ordered.length) return i + 1;
        // Past the last ready beat: stop and rewind for replay.
        setPlaying(false);
        return 0;
      });
    }
    function onTime() { setTickFlag((t) => t + 1); }
    // A beat that fails to load (r2.dev 429, network blip) is skipped
    // rather than freezing the whole preview.
    a.addEventListener("ended", advance);
    a.addEventListener("error", advance);
    a.addEventListener("timeupdate", onTime);
    return () => {
      a.removeEventListener("ended", advance);
      a.removeEventListener("error", advance);
      a.removeEventListener("timeupdate", onTime);
    };
  }, [ordered.length]);

  // (Re)start playback whenever the track changes while in the playing
  // state — this is the auto-continue after `ended` advances idx, and
  // also what makes the skip buttons keep playing.
  useEffect(() => {
    const a = audioRef.current;
    if (!a || !playing || !current) return;
    a.play().catch(() => setPlaying(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, playing, current?.url]);

  function toggle() {
    const a = audioRef.current;
    if (!a || !current) return;
    if (playing) {
      a.pause();
      setPlaying(false);
    } else {
      a.play().then(() => setPlaying(true)).catch(() => setPlaying(false));
    }
  }

  function skip(delta: number) {
    setIdx((i) => Math.max(0, Math.min(readyCount - 1, i + delta)));
    setTickFlag((t) => t + 1);
  }

  if (readyCount === 0) return null;

  const a = audioRef.current;
  const beatFraction = a && isFinite(a.duration) && a.duration > 0 ? a.currentTime / a.duration : 0;
  const pct = readyCount > 0 ? Math.min(100, ((idx + beatFraction) / readyCount) * 100) : 0;

  return (
    <div
      className="rounded-2xl p-4 sm:p-5 space-y-3"
      style={{ background: "#ffffff", border: "1px solid oklch(0.85 0 0)" }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "oklch(0.35 0 0)" }}>
            Full voiceover preview
          </p>
          <p className="text-[11px] mt-0.5" style={{ color: "oklch(0.45 0 0)" }}>
            Plays every beat in order
          </p>
        </div>
        <span className="text-[11px] font-mono tabular-nums shrink-0" style={{ color: "oklch(0.45 0 0)" }}>
          {readyCount < totalBeats ? `${readyCount} of ${totalBeats} beats ready` : `${readyCount} beats`}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={toggle}
          aria-label={playing ? "Pause" : "Play all beats"}
          className="w-9 h-9 rounded-full flex items-center justify-center transition-opacity hover:opacity-90 shrink-0"
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
              className="h-full rounded-full transition-all duration-200"
              style={{ width: `${pct}%`, background: "oklch(0.55 0.15 145)" }}
            />
          </div>
          <div className="flex items-center justify-between mt-1">
            <span className="text-[11px] font-mono tabular-nums" style={{ color: "oklch(0.45 0 0)" }}>
              Beat {current ? current.beatNumber : "—"} · {Math.min(idx + 1, readyCount)} / {readyCount}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => skip(-1)}
                disabled={idx <= 0}
                aria-label="Previous beat"
                className="px-2 py-0.5 rounded-md text-[11px] font-medium transition-all hover:opacity-90 disabled:opacity-40"
                style={{ background: "oklch(0.96 0 0)", border: "1px solid oklch(0.85 0 0)", color: "oklch(0.4 0 0)" }}
              >
                ‹ Prev
              </button>
              <button
                onClick={() => skip(1)}
                disabled={idx >= readyCount - 1}
                aria-label="Next beat"
                className="px-2 py-0.5 rounded-md text-[11px] font-medium transition-all hover:opacity-90 disabled:opacity-40"
                style={{ background: "oklch(0.96 0 0)", border: "1px solid oklch(0.85 0 0)", color: "oklch(0.4 0 0)" }}
              >
                Next ›
              </button>
            </div>
          </div>
        </div>
      </div>
      <audio ref={audioRef} src={current?.url} preload="metadata" />
    </div>
  );
}
