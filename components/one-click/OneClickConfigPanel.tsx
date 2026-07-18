"use client";

import { useEffect, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { SlidersHorizontal, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { ModelPicker } from "@/components/ModelPicker";
import { VoicePickerGrid } from "@/components/VoicePickerGrid";
import type { OneClickConfig } from "@/lib/one-click/config";
import { emptyConfig } from "@/lib/one-click/config";
import type { KieModel } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));

// Corner presets → logo position fractions (assemble-page semantics).
const LOGO_POSITIONS: { id: string; label: string; x: number; y: number }[] = [
  { id: "tl", label: "Top left",     x: 0.02, y: 0.02 },
  { id: "tr", label: "Top right",    x: 0.88, y: 0.02 },
  { id: "bl", label: "Bottom left",  x: 0.02, y: 0.88 },
  { id: "br", label: "Bottom right", x: 0.88, y: 0.88 },
];

type ChainSlot = "primary" | "secondary" | "fallback";
const SLOTS: { id: ChainSlot; label: string; optional: boolean }[] = [
  { id: "primary",   label: "Primary",        optional: false },
  { id: "secondary", label: "Secondary",      optional: true },
  { id: "fallback",  label: "Final fallback", optional: true },
];

/** Slot switcher above a ModelPicker: pick which chain position the
 *  picker below is editing. Filled optional slots get a clear (×). */
function SlotTabs({ chain, active, onActive, onClear }: {
  chain: { primary: string; secondary?: string | null; fallback?: string | null };
  active: ChainSlot;
  onActive: (s: ChainSlot) => void;
  onClear: (s: ChainSlot) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-xl p-1"
      style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-card)" }}>
      {SLOTS.map((s) => {
        const value = chain[s.id];
        const isActive = active === s.id;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onActive(s.id)}
            aria-pressed={isActive}
            className="flex-1 py-2 rounded-lg text-sm font-semibold transition-all flex items-center justify-center gap-1.5 cursor-pointer"
            style={isActive
              ? { background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.88 0.12 285)" }
              : { color: "var(--c-55)" }}
          >
            {s.label}
            {value ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded font-bold"
                style={{ background: "oklch(0.72 0.25 285 / 0.2)", color: "oklch(0.88 0.12 285)" }}>
                set
              </span>
            ) : s.optional ? (
              <span className="text-[10px] opacity-60">none</span>
            ) : null}
            {value && s.optional && (
              <span
                role="button"
                title="Clear this slot"
                onClick={(e) => { e.stopPropagation(); onClear(s.id); }}
                className="w-4 h-4 rounded flex items-center justify-center hover:opacity-70"
                style={{ background: "oklch(0 0 0 / 0.2)" }}
              >
                <X size={10} />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

// Full-page 1Click preferences editor — the Setup page's 1Click tab.
// Reuses the product's real pickers: the voiceover step's VoiceOption
// cards and the generate step's ModelPicker (tabs, search, cost/speed
// chips), wrapped in Primary/Secondary/Final-fallback slot tabs.
export function OneClickConfigPanel() {
  const { data: cfgData, mutate } = useSWR<{ configured: boolean; config: OneClickConfig }>(
    "/api/one-click/config", fetcher,
  );
  const { data: voices } = useSWR<KieModel[]>("/api/kie/models?type=tts", fetcher);
  const { data: imageModels } = useSWR<KieModel[]>("/api/kie/models?type=image", fetcher);
  const { data: videoModels } = useSWR<KieModel[]>("/api/kie/models?type=video", fetcher);

  const [cfg, setCfg] = useState<OneClickConfig>(emptyConfig());
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const [imageSlot, setImageSlot] = useState<ChainSlot>("primary");
  const [videoSlot, setVideoSlot] = useState<ChainSlot>("primary");

  useEffect(() => {
    if (hydrated || !cfgData) return;
    const base = cfgData.config;
    setCfg({
      ...base,
      tts: {
        voiceId: base.tts.voiceId || voices?.[0]?.id || "",
        modelId: base.tts.modelId || voices?.[0]?.id || "",
      },
      images: { ...base.images, primary: base.images.primary || imageModels?.[0]?.id || "" },
      videos: { ...base.videos, primary: base.videos.primary || videoModels?.[0]?.id || "" },
    });
    if (voices && imageModels && videoModels) setHydrated(true);
  }, [hydrated, cfgData, voices, imageModels, videoModels]);

  /** Assign a model to a chain slot, evicting it from any other slot so
   *  a chain never repeats a model. */
  function setChain(kind: "images" | "videos", slot: ChainSlot, id: string) {
    setCfg((prev) => {
      const next = { ...prev[kind] };
      // Evict the model from any other slot first.
      if (slot !== "primary" && next.primary === id) next.primary = "";
      if (slot !== "secondary" && next.secondary === id) next.secondary = null;
      if (slot !== "fallback" && next.fallback === id) next.fallback = null;
      if (slot === "primary") next.primary = id;
      else if (slot === "secondary") next.secondary = id;
      else next.fallback = id;
      return { ...prev, [kind]: next };
    });
  }
  function clearChain(kind: "images" | "videos", slot: ChainSlot) {
    setCfg((prev) => ({ ...prev, [kind]: { ...prev[kind], [slot]: null } }));
  }

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/one-click/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(d.error ?? `Save failed (${res.status})`);
      toast.success("1Click preferences saved");
      mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const inputCls = "w-full px-3 py-2.5 rounded-xl text-sm outline-none transition-all";
  const inputStyle = { background: "var(--bg-input)", border: "1px solid var(--bd-8)", color: "var(--c-90)" } as const;
  const labelCls = "block text-xs font-semibold uppercase tracking-wider mb-1.5";
  const labelStyle = { color: "var(--c-50)" } as const;
  const canSave = Boolean(cfg.tts.voiceId && cfg.images.primary && cfg.videos.primary);

  return (
    <div className="space-y-10 pb-28">
      {/* Heading */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
            <SlidersHorizontal size={18} style={{ color: "oklch(0.72 0.25 285)" }} />
          </div>
          <h1 className="text-2xl font-bold text-foreground">1Click</h1>
        </div>
        <p className="text-sm leading-relaxed max-w-2xl" style={{ color: "var(--c-50)" }}>
          Your defaults for fully automatic videos. Set them once — every 1Click run uses these choices at
          each step of the pipeline, and mid-run projects keep the settings they started with.
        </p>
        {cfgData && !cfgData.configured && (
          <p className="text-xs font-semibold px-3 py-2 rounded-lg inline-block"
            style={{ background: "oklch(0.72 0.18 65 / 0.12)", color: "oklch(0.72 0.18 65)", border: "1px solid oklch(0.72 0.18 65 / 0.3)" }}>
            Not configured yet — pick your preferences below and save to unlock 1Click.
          </p>
        )}
      </div>

      {/* Voice — the voiceover step's picker cards */}
      <section className="space-y-5 p-6 sm:p-8 rounded-2xl"
        style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid white" }}>
        <div>
          <h2 className="text-base font-bold" style={{ color: "var(--c-90)" }}>Voiceover voice</h2>
          <p className="text-xs mt-1" style={{ color: "var(--c-45)" }}>Every 1Click video narrates with this voice.</p>
        </div>
        <VoicePickerGrid
          voices={voices}
          selectedId={cfg.tts.voiceId || null}
          onSelect={(id) => setCfg({ ...cfg, tts: { modelId: id, voiceId: id } })}
          playingId={playingVoice}
          onPlayToggle={setPlayingVoice}
        />
      </section>

      {/* Image models — the generate step's picker + chain slots */}
      <section className="space-y-5 p-6 sm:p-8 rounded-2xl"
        style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid white" }}>
        <div className="space-y-2.5">
          <h2 className="text-base font-bold" style={{ color: "var(--c-90)" }}>Image models</h2>
          <div className="rounded-xl px-4 py-3 text-sm leading-relaxed"
            style={{
              background: "oklch(0.72 0.25 285 / 0.08)",
              border: "1px solid oklch(0.72 0.25 285 / 0.25)",
              color: "var(--c-80)",
            }}>
            Pick your 3 preferred models: if the primary fails mid-run, 1Click automatically retries with the next
            one.
          </div>
        </div>
        <SlotTabs chain={cfg.images} active={imageSlot} onActive={setImageSlot}
          onClear={(s) => clearChain("images", s)} />
        <ModelPicker
          type="image"
          models={imageModels}
          selectedModelId={cfg.images[imageSlot] ?? null}
          onSelectModel={(id) => setChain("images", imageSlot, id)}
          selectedAspectRatio={cfg.output.aspectRatio}
          onSelectAspectRatio={(r) => setCfg({ ...cfg, output: { ...cfg.output, aspectRatio: r } })}
          selectedResolution={cfg.output.resolution || null}
          onSelectResolution={(r) => setCfg({ ...cfg, output: { ...cfg.output, resolution: r ?? "1K" } })}
          tip=""
          hideCategoryTabs
        />
      </section>

      {/* Video models — chain slots + the generate step's picker */}
      <section className="space-y-5 p-6 sm:p-8 rounded-2xl"
        style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid white" }}>
        <div>
          <h2 className="text-base font-bold" style={{ color: "var(--c-90)" }}>Video models</h2>
          <p className="text-xs mt-1" style={{ color: "var(--c-45)" }}>
            Clips inherit the image aspect ratio, so there&apos;s nothing to re-pick here besides the models
            and clip duration.
          </p>
        </div>
        <SlotTabs chain={cfg.videos} active={videoSlot} onActive={setVideoSlot}
          onClear={(s) => clearChain("videos", s)} />
        <ModelPicker
          type="video"
          models={videoModels}
          selectedModelId={cfg.videos[videoSlot] ?? null}
          onSelectModel={(id) => setChain("videos", videoSlot, id)}
          selectedAspectRatio={cfg.output.aspectRatio}
          onSelectAspectRatio={() => {}}
          hideAspectRatio
          selectedDuration={cfg.videos.duration ?? 5}
          onSelectDuration={(d) => setCfg({ ...cfg, videos: { ...cfg.videos, duration: d } })}
          selectedResolution={cfg.output.resolution || null}
          onSelectResolution={(r) => setCfg({ ...cfg, output: { ...cfg.output, resolution: r ?? "1K" } })}
          tip=""
          hideCategoryTabs
        />
      </section>

      {/* Assembly */}
      <section className="space-y-5 p-6 sm:p-8 rounded-2xl"
        style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid white" }}>
        <div>
          <h2 className="text-base font-bold" style={{ color: "var(--c-90)" }}>Assembly</h2>
          <p className="text-xs mt-1" style={{ color: "var(--c-45)" }}>Applied when 1Click stitches the final video.</p>
        </div>

        <label className="flex items-center gap-2.5 text-sm cursor-pointer select-none" style={{ color: "var(--c-70)" }}>
          <input
            type="checkbox"
            checked={cfg.assemble.captionsEnabled}
            onChange={(e) => setCfg({ ...cfg, assemble: { ...cfg.assemble, captionsEnabled: e.target.checked } })}
            className="accent-[oklch(0.72_0.25_285)]"
          />
          Burn in captions
        </label>

        <div className="flex gap-4 items-end flex-wrap">
          <div className="flex-1 min-w-[260px]">
            <label className={labelCls} style={labelStyle}>Background music URL (optional — direct mp3 link)</label>
            <input type="url" className={inputCls} style={inputStyle}
              placeholder="https://…/track.mp3 — leave empty for no music"
              value={cfg.assemble.bgMusicUrl ?? ""}
              onChange={(e) => setCfg({ ...cfg, assemble: { ...cfg.assemble, bgMusicUrl: e.target.value || null } })}
            />
          </div>
          <div className="w-44 shrink-0">
            <label className={labelCls} style={labelStyle}>Music volume · {Math.round(cfg.assemble.bgMusicVolume * 100)}%</label>
            <input type="range" min={0} max={100}
              value={Math.round(cfg.assemble.bgMusicVolume * 100)}
              onChange={(e) => setCfg({ ...cfg, assemble: { ...cfg.assemble, bgMusicVolume: Number(e.target.value) / 100 } })}
              className="w-full accent-[oklch(0.72_0.25_285)]"
            />
          </div>
        </div>

        <div className="flex gap-4 items-end flex-wrap">
          <div className="flex-1 min-w-[260px]">
            <label className={labelCls} style={labelStyle}>Logo URL (optional)</label>
            <input type="url" className={inputCls} style={inputStyle}
              placeholder="https://…/logo.png — leave empty for no logo"
              value={cfg.assemble.logoUrl ?? ""}
              onChange={(e) => setCfg({ ...cfg, assemble: { ...cfg.assemble, logoUrl: e.target.value || null } })}
            />
          </div>
          <div className="w-48 shrink-0">
            <label className={labelCls} style={labelStyle}>Logo position</label>
            <select
              className={inputCls}
              style={{ ...inputStyle, cursor: "pointer" }}
              value={LOGO_POSITIONS.find((p) => Math.abs(p.x - cfg.assemble.logoX) < 0.01 && Math.abs(p.y - cfg.assemble.logoY) < 0.01)?.id ?? "tl"}
              onChange={(e) => {
                const p = LOGO_POSITIONS.find((x) => x.id === e.target.value) ?? LOGO_POSITIONS[0];
                setCfg({ ...cfg, assemble: { ...cfg.assemble, logoX: p.x, logoY: p.y } });
              }}
            >
              {LOGO_POSITIONS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </select>
          </div>
        </div>
      </section>

      {/* Sticky save bar */}
      <div className="fixed bottom-0 left-0 right-0 z-20 py-3"
        style={{ background: "var(--bg-header-2)", borderTop: "1px solid var(--bd-6)", backdropFilter: "blur(12px)" }}>
        <div className="px-4 sm:px-8 lg:px-12 flex items-center gap-3 flex-wrap">
          <p className="flex-1 min-w-[200px] text-xs" style={{ color: "var(--c-45)" }}>
            {canSave
              ? "These become the defaults for every future 1Click run."
              : "Pick a voice, a primary image model, and a primary video model to save."}
          </p>
          <button
            onClick={save}
            disabled={saving || !canSave}
            className="shrink-0 inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-40 cursor-pointer"
            style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
          >
            {saving ? (<><Spinner size={13} /> Saving…</>) : "Save 1Click Setup"}
          </button>
        </div>
      </div>
    </div>
  );
}
