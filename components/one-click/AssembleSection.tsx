"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { presignedUpload } from "@/lib/upload-client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import type { OneClickConfig } from "@/lib/one-click/config";

// The assemble step's settings, reproduced 1:1 for the 1Click config:
// the single-bar Background music picker (choose file → play preview +
// volume + clear), the Channel logo bar with the drag-to-position /
// drag-corner-to-resize surface, and the Captions card (toggle, style,
// size, position, language). Values bind to the preset instead of a
// project row; uploads land under the user's one-click settings scope.

const CAPTION_STYLES = [
  { id: "classic", label: "Classic", hint: "White, black outline" },
  { id: "bold",    label: "Bold",    hint: "Yellow, bold" },
  { id: "boxed",   label: "Boxed",   hint: "White on dark box" },
  { id: "minimal", label: "Minimal", hint: "White, thin outline" },
] as const;
const CAPTION_SIZES     = [{ id: "small", label: "S" }, { id: "medium", label: "M" }, { id: "large", label: "L" }] as const;
const CAPTION_POSITIONS = [{ id: "bottom", label: "Bottom" }, { id: "top", label: "Top" }] as const;
const CAPTION_LANGUAGES = [
  { code: "source", label: "Source language" },
  { code: "Spanish", label: "Spanish" },
  { code: "French", label: "French" },
  { code: "Portuguese", label: "Portuguese" },
  { code: "German", label: "German" },
  { code: "Italian", label: "Italian" },
] as const;

type AssembleValue = OneClickConfig["assemble"];

export function AssembleSection({ value, aspectRatio, onChange }: {
  value: AssembleValue;
  /** From the preset's output format — shapes the logo drag surface. */
  aspectRatio: string;
  onChange: (v: AssembleValue) => void;
}) {
  const set = (patch: Partial<AssembleValue>) => onChange({ ...value, ...patch });

  // ── Background music ────────────────────────────────────────────
  const bgmInputRef = useRef<HTMLInputElement>(null);
  const bgmAudioRef = useRef<HTMLAudioElement>(null);
  const [bgmPlaying, setBgmPlaying] = useState(false);
  const [bgmUploading, setBgmUploading] = useState(false);
  const [bgmDisclaimerOpen, setBgmDisclaimerOpen] = useState(false);

  async function uploadBgm(f: File) {
    setBgmUploading(true);
    try {
      const url = await presignedUpload(f, "one-click", "bgm");
      set({ bgMusicUrl: url });
      toast.success("Music uploaded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Music upload failed");
    } finally {
      setBgmUploading(false);
    }
  }

  // ── Channel logo ────────────────────────────────────────────────
  const logoInputRef = useRef<HTMLInputElement>(null);
  const [logoUploading, setLogoUploading] = useState(false);

  async function uploadLogo(f: File) {
    setLogoUploading(true);
    try {
      const url = await presignedUpload(f, "one-click", "logo");
      set({ logoUrl: url });
      toast.success("Logo uploaded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Logo upload failed");
    } finally {
      setLogoUploading(false);
    }
  }

  // Stop bgm preview when the track is cleared.
  useEffect(() => {
    if (!value.bgMusicUrl) { bgmAudioRef.current?.pause(); setBgmPlaying(false); }
  }, [value.bgMusicUrl]);

  const aspect = (aspectRatio || "16:9").replace(":", " / ");

  function onDragLogo(e: React.PointerEvent<HTMLImageElement>) {
    e.preventDefault();
    e.stopPropagation();
    const surface = (e.currentTarget.parentElement?.parentElement as HTMLElement | null);
    if (!surface) return;
    const img = e.currentTarget;
    img.setPointerCapture(e.pointerId);
    const startBox = surface.getBoundingClientRect();
    const offsetX = e.clientX - img.getBoundingClientRect().left;
    const offsetY = e.clientY - img.getBoundingClientRect().top;
    const move = (ev: PointerEvent) => {
      const localX = ev.clientX - startBox.left - offsetX;
      const localY = ev.clientY - startBox.top - offsetY;
      const maxX = 1 - value.logoSize;
      const approxLogoHpct = img.offsetHeight / startBox.height;
      const maxY = Math.max(0, 1 - approxLogoHpct);
      onChange({
        ...value,
        logoX: Math.max(0, Math.min(maxX, localX / startBox.width)),
        logoY: Math.max(0, Math.min(maxY, localY / startBox.height)),
      });
    };
    const up = (ev: PointerEvent) => {
      img.releasePointerCapture(ev.pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  function onResizeLogo(e: React.PointerEvent<HTMLSpanElement>) {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget;
    const surface = handle.parentElement?.parentElement as HTMLElement | null;
    if (!surface) return;
    handle.setPointerCapture(e.pointerId);
    const startBox = surface.getBoundingClientRect();
    const logoLeftPx = startBox.left + value.logoX * startBox.width;
    const move = (ev: PointerEvent) => {
      const newWidthPx = Math.max(0, ev.clientX - logoLeftPx);
      const newSize = Math.max(0.03, Math.min(0.4, newWidthPx / startBox.width));
      const maxSize = Math.max(0.03, 1 - value.logoX);
      onChange({ ...value, logoSize: Math.min(newSize, maxSize) });
    };
    const up = (ev: PointerEvent) => {
      handle.releasePointerCapture(ev.pointerId);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  return (
    <div className="space-y-4">
      {/* Background music — single-bar picker, as on the assemble step */}
      <div className="flex items-center gap-3 rounded-2xl px-4 py-2.5 flex-wrap"
        style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
        <span aria-hidden="true" className="text-base shrink-0" style={{ color: "oklch(0.72 0.25 285)" }}>♫</span>
        {!value.bgMusicUrl && !bgmUploading ? (
          <>
            <p className="text-sm font-semibold flex-1">Background music</p>
            <button
              type="button"
              onClick={() => bgmInputRef.current?.click()}
              className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all shrink-0 cursor-pointer"
              style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.88 0.12 285)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}
            >
              Choose file
            </button>
          </>
        ) : bgmUploading ? (
          <p className="text-xs flex-1" style={{ color: "var(--c-50)" }}>Uploading…</p>
        ) : (
          <>
            <button
              type="button"
              onClick={() => {
                const a = bgmAudioRef.current;
                if (!a) return;
                if (a.paused) {
                  a.volume = Math.max(0, Math.min(1, value.bgMusicVolume));
                  a.play().catch(() => {});
                } else {
                  a.pause();
                }
              }}
              title={bgmPlaying ? "Pause preview" : "Play preview"}
              aria-label={bgmPlaying ? "Pause background music" : "Play background music"}
              className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-transform hover:scale-105 cursor-pointer"
              style={{ background: "oklch(0.72 0.25 285)", color: "#fff" }}
            >
              {bgmPlaying ? (
                <span className="flex gap-[2px]">
                  <span className="block w-[3px] h-3 rounded-sm" style={{ background: "currentColor" }} />
                  <span className="block w-[3px] h-3 rounded-sm" style={{ background: "currentColor" }} />
                </span>
              ) : (
                <span className="block w-0 h-0 ml-[2px]"
                  style={{ borderLeft: "8px solid currentColor", borderTop: "5px solid transparent", borderBottom: "5px solid transparent" }} />
              )}
            </button>
            <audio
              ref={bgmAudioRef}
              src={value.bgMusicUrl ?? undefined}
              preload="none"
              onPlay={() => setBgmPlaying(true)}
              onPause={() => setBgmPlaying(false)}
              onEnded={() => setBgmPlaying(false)}
            />
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--c-40)" }}>
                Background music
              </p>
              <p className="text-xs font-medium truncate" style={{ color: "var(--c-80)" }} title={value.bgMusicUrl ?? ""}>
                {value.bgMusicUrl?.split("/").pop() ?? "Saved track"}
              </p>
              <button
                type="button"
                onClick={() => setBgmDisclaimerOpen(true)}
                className="text-[10px] underline underline-offset-2 hover:opacity-80 cursor-pointer"
                style={{ color: "oklch(0.7 0.22 25)" }}
              >
                Disclaimer
              </button>
            </div>
            <div className="flex items-center gap-2 w-full sm:w-auto sm:shrink-0">
              <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--c-40)" }}>Vol</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={value.bgMusicVolume}
                onChange={(e) => set({ bgMusicVolume: parseFloat(e.target.value) })}
                aria-label="Background music volume"
                className="flex-1 sm:flex-none sm:w-32"
              />
              <span className="text-[11px] font-mono tabular-nums w-9 text-right" style={{ color: "var(--c-60)" }}>
                {Math.round(value.bgMusicVolume * 100)}%
              </span>
              <button
                type="button"
                onClick={() => set({ bgMusicUrl: null })}
                title="Remove background music"
                className="w-7 h-7 rounded-lg flex items-center justify-center transition-opacity hover:opacity-90 shrink-0 cursor-pointer"
                style={{ background: "transparent", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}
              >
                ×
              </button>
            </div>
          </>
        )}
        <input
          ref={bgmInputRef}
          type="file"
          accept="audio/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            if (f) void uploadBgm(f);
            e.currentTarget.value = "";
          }}
        />
      </div>

      {/* Channel logo — bar + drag/resize surface, as on the assemble step */}
      <div className="rounded-2xl px-4 py-2.5 space-y-3"
        style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
        <div className="flex items-center gap-3 flex-wrap">
          <span aria-hidden="true" className="text-base shrink-0" style={{ color: "oklch(0.72 0.25 285)" }}>◈</span>
          {!value.logoUrl && !logoUploading ? (
            <>
              <p className="text-sm font-semibold flex-1">Channel logo</p>
              <button
                type="button"
                onClick={() => logoInputRef.current?.click()}
                className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all shrink-0 cursor-pointer"
                style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.88 0.12 285)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}
              >
                Choose file
              </button>
            </>
          ) : logoUploading ? (
            <p className="text-xs flex-1" style={{ color: "var(--c-50)" }}>Uploading…</p>
          ) : (
            <>
              <div className="min-w-0 flex-1">
                <p className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--c-40)" }}>
                  Channel logo
                </p>
                <p className="text-xs font-medium truncate" style={{ color: "var(--c-80)" }} title={value.logoUrl ?? ""}>
                  {value.logoUrl?.split("/").pop() ?? "Saved logo"}
                </p>
              </div>
              <div className="flex items-center gap-2 w-full sm:w-auto sm:shrink-0">
                <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--c-40)" }}>Size</span>
                <input
                  type="range"
                  min={0.03}
                  max={0.4}
                  step={0.01}
                  value={value.logoSize}
                  onChange={(e) => set({ logoSize: parseFloat(e.target.value) })}
                  aria-label="Logo size"
                  className="flex-1 sm:flex-none sm:w-32"
                />
                <span className="text-[11px] font-mono tabular-nums w-9 text-right" style={{ color: "var(--c-60)" }}>
                  {Math.round(value.logoSize * 100)}%
                </span>
                <button
                  type="button"
                  onClick={() => set({ logoUrl: null })}
                  title="Remove channel logo"
                  className="w-7 h-7 rounded-lg flex items-center justify-center transition-opacity hover:opacity-90 shrink-0 cursor-pointer"
                  style={{ background: "transparent", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}
                >
                  ×
                </button>
              </div>
            </>
          )}
          <input
            ref={logoInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              if (f) void uploadLogo(f);
              e.currentTarget.value = "";
            }}
          />
        </div>

        {value.logoUrl && (
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--c-40)" }}>
              Drag to position · drag corner to resize
            </p>
            <div
              className="relative w-full rounded-lg overflow-hidden select-none"
              style={{
                aspectRatio: aspect,
                maxWidth: "320px",
                background: "linear-gradient(135deg, oklch(0.16 0 0), oklch(0.22 0 0))",
                border: "1px solid var(--bd-card)",
              }}
            >
              <div
                className="absolute group"
                style={{
                  left: `${value.logoX * 100}%`,
                  top: `${value.logoY * 100}%`,
                  width: `${value.logoSize * 100}%`,
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={value.logoUrl}
                  alt="Channel logo"
                  draggable={false}
                  onPointerDown={onDragLogo}
                  className="touch-none block w-full h-auto"
                  style={{ cursor: "grab", opacity: 0.95, filter: "drop-shadow(0 2px 8px oklch(0 0 0 / 0.5))" }}
                />
                <span
                  onPointerDown={onResizeLogo}
                  aria-label="Resize logo"
                  title="Drag to resize"
                  className="absolute touch-none flex items-center justify-center"
                  style={{
                    right: "-6px",
                    bottom: "-6px",
                    width: "14px",
                    height: "14px",
                    borderRadius: "9999px",
                    background: "oklch(0.72 0.25 285)",
                    border: "2px solid #ffffff",
                    cursor: "nwse-resize",
                  }}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Captions — toggle + style/size/position/language, as on the assemble step */}
      <div className="rounded-2xl p-5" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-sm font-semibold">Captions</p>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>Burned into the video — always visible</p>
          </div>
          <button
            type="button"
            onClick={() => set({ captionsEnabled: !value.captionsEnabled })}
            className="relative w-11 h-6 rounded-full transition-all shrink-0 cursor-pointer"
            style={{ background: value.captionsEnabled ? "oklch(0.72 0.25 285)" : "var(--c-22)", border: "1px solid var(--bd-10)" }}
          >
            <span className="absolute top-0.5 w-5 h-5 rounded-full transition-all"
              style={{ background: "oklch(0.95 0 0)", left: value.captionsEnabled ? "calc(100% - 1.375rem)" : "0.125rem" }} />
          </button>
        </div>

        {value.captionsEnabled && (
          <div className="space-y-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Style</p>
              <div className="grid grid-cols-2 gap-1.5">
                {CAPTION_STYLES.map((s) => (
                  <button key={s.id} type="button" onClick={() => set({ captionsStyle: s.id })}
                    className="py-2 px-3 rounded-xl text-left transition-all cursor-pointer"
                    style={(value.captionsStyle ?? "classic") === s.id ? {
                      background: "oklch(0.72 0.25 285 / 0.15)",
                      border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                    } : {
                      background: "var(--bg-input)",
                      border: "1px solid var(--bd-card)",
                    }}>
                    <p className="text-xs font-medium" style={{ color: (value.captionsStyle ?? "classic") === s.id ? "oklch(0.88 0.12 285)" : "var(--c-60)" }}>{s.label}</p>
                    <p className="text-xs mt-0.5" style={{ color: "var(--c-38)" }}>{s.hint}</p>
                  </button>
                ))}
              </div>
            </div>

            <div className="flex gap-4">
              <div className="flex-1">
                <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Size</p>
                <div className="flex gap-1.5">
                  {CAPTION_SIZES.map((s) => (
                    <button key={s.id} type="button" onClick={() => set({ captionsSize: s.id })}
                      className="flex-1 py-1.5 rounded-xl text-xs font-semibold transition-all cursor-pointer"
                      style={(value.captionsSize ?? "medium") === s.id ? {
                        background: "oklch(0.72 0.25 285 / 0.15)",
                        border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                        color: "oklch(0.88 0.12 285)",
                      } : {
                        background: "var(--bg-input)",
                        border: "1px solid var(--bd-card)",
                        color: "var(--c-50)",
                      }}>
                      {s.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex-1">
                <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Position</p>
                <div className="flex gap-1.5">
                  {CAPTION_POSITIONS.map((p) => (
                    <button key={p.id} type="button" onClick={() => set({ captionsPosition: p.id })}
                      className="flex-1 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer"
                      style={(value.captionsPosition ?? "bottom") === p.id ? {
                        background: "oklch(0.72 0.25 285 / 0.15)",
                        border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                        color: "oklch(0.88 0.12 285)",
                      } : {
                        background: "var(--bg-input)",
                        border: "1px solid var(--bd-card)",
                        color: "var(--c-50)",
                      }}>
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div>
              <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Language</p>
              <div className="flex flex-wrap gap-1.5">
                {CAPTION_LANGUAGES.map((lang) => (
                  <button key={lang.code} type="button" onClick={() => set({ captionsLanguage: lang.code })}
                    className="px-3 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer"
                    style={(value.captionsLanguage ?? "source") === lang.code ? {
                      background: "oklch(0.72 0.25 285 / 0.15)",
                      border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                      color: "oklch(0.88 0.12 285)",
                    } : {
                      background: "var(--bg-input)",
                      border: "1px solid var(--bd-card)",
                      color: "var(--c-50)",
                    }}>
                    {lang.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <Dialog open={bgmDisclaimerOpen} onOpenChange={setBgmDisclaimerOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Background music disclaimer</DialogTitle>
            <DialogDescription>
              We do not take responsibility for copyright claims on background music. Please ensure you have the rights to use any track you upload.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setBgmDisclaimerOpen(false)}
              className="px-4 py-2 rounded-lg text-sm font-semibold transition-all"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
            >
              Got it
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
