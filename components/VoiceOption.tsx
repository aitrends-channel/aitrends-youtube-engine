"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { KieModel } from "@/lib/types";

// ── Voice picker (mirrors the generate page's VoiceOption) ──────────
export function VoiceOption({
  model, selected, onSelect, isPlaying, onPlayToggle,
}: {
  model: KieModel; selected: boolean; onSelect: () => void;
  isPlaying: boolean; onPlayToggle: (id: string | null) => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  useEffect(() => {
    if (!isPlaying && audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
  }, [isPlaying]);
  useEffect(() => () => { audioRef.current?.pause(); }, []);
  async function togglePreview(e: React.MouseEvent) {
    e.stopPropagation();
    if (!model.previewUrl) return;
    if (isPlaying) {
      onPlayToggle(null);
      return;
    }
    onSelect();

    // Same-origin dynamic previews (the free Google voices → our /preview
    // route) are auth'd and take a couple seconds to synthesize. Fetch
    // them explicitly so we can (a) play reliably from a blob and (b)
    // surface the error — "connect your key", quota, etc. — instead of
    // failing silently. ElevenLabs previews are CROSS-ORIGIN static mp3s,
    // where fetch() would trip CORS, so those keep the direct-Audio path.
    const isDynamic = model.previewUrl.startsWith("/");
    if (!isDynamic) {
      const audio = new Audio(model.previewUrl);
      audioRef.current = audio;
      audio.onended = () => onPlayToggle(null);
      audio.onerror = () => onPlayToggle(null);
      audio.play().catch(() => onPlayToggle(null));
      onPlayToggle(model.id);
      return;
    }

    onPlayToggle(model.id); // show the "playing" state while it loads
    try {
      const res = await fetch(model.previewUrl);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error || `Preview failed (${res.status})`);
      }
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      audioRef.current = audio;
      const cleanup = () => { onPlayToggle(null); URL.revokeObjectURL(url); };
      audio.onended = cleanup;
      audio.onerror = cleanup;
      await audio.play();
    } catch (err) {
      onPlayToggle(null);
      toast.error(err instanceof Error ? err.message : "Voice preview failed");
    }
  }
  return (
    <div
      role="button"
      onClick={onSelect}
      className="cursor-pointer p-3 rounded-xl transition-all select-none"
      style={selected ? {
        background: "oklch(0.72 0.25 285 / 0.1)",
        border: "1px solid oklch(0.72 0.25 285 / 0.3)",
        color: "var(--c-90)",
      } : {
        background: "var(--bg-input)",
        // Voice picker items keep the subtle default border — the white
        // card border is only for the step's content panels.
        border: "1px solid var(--bd-7)",
        color: "var(--c-60)",
      }}
    >
      <div className="flex items-center gap-2">
        <p className="font-medium text-xs flex-1 truncate">
          {model.name}
          {(model.id.startsWith("google/") || model.id.startsWith("qwen/")) && (
            <span style={{ color: "var(--primary)" }}> - free</span>
          )}
        </p>
        {model.previewUrl && (
          <button
            onClick={togglePreview}
            title={isPlaying ? "Stop preview" : "Preview voice"}
            className="w-6 h-6 rounded flex items-center justify-center shrink-0 transition-colors"
            style={{
              background: isPlaying ? "oklch(0.72 0.25 285 / 0.15)" : "oklch(0.2 0 0)",
              color: isPlaying ? "oklch(0.72 0.25 285)" : "var(--c-45)",
              border: "1px solid var(--bd-10)",
            }}
          >
            {isPlaying ? (
              <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
                <rect x="0.5" y="0" width="2.5" height="8" rx="0.5" />
                <rect x="5" y="0" width="2.5" height="8" rx="0.5" />
              </svg>
            ) : (
              <svg width="7" height="9" viewBox="0 0 7 9" fill="currentColor">
                <path d="M0 0.5L7 4.5L0 8.5V0.5Z" />
              </svg>
            )}
          </button>
        )}
      </div>
      {model.tags && model.tags.length > 0 && (
        <div className="flex gap-1 mt-1.5 flex-wrap">
          {model.tags.map((tag) => (
            <span key={tag} className="px-1.5 py-0.5 rounded text-xs"
              style={{ background: "var(--bg-track)", color: "var(--c-45)" }}>
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
