"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { SlidersHorizontal, Play, Square } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import type { OneClickConfig, ModelChain } from "@/lib/one-click/config";
import { emptyConfig } from "@/lib/one-click/config";
import type { KieModel } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));

const ASPECT_RATIOS = ["16:9", "9:16", "1:1"];
const RESOLUTIONS = ["1080p", "2K"];

// Corner presets → logo position fractions (assemble-page semantics).
const LOGO_POSITIONS: { id: string; label: string; x: number; y: number }[] = [
  { id: "tl", label: "Top left",     x: 0.02, y: 0.02 },
  { id: "tr", label: "Top right",    x: 0.88, y: 0.02 },
  { id: "bl", label: "Bottom left",  x: 0.02, y: 0.88 },
  { id: "br", label: "Bottom right", x: 0.88, y: 0.88 },
];

const CHAIN_BADGES = ["Primary", "Secondary", "Final fallback"] as const;

function chainToList(c: ModelChain): string[] {
  return [c.primary, c.secondary ?? "", c.fallback ?? ""].filter(Boolean);
}
function listToChain(ids: string[]): { primary: string; secondary: string | null; fallback: string | null } {
  return { primary: ids[0] ?? "", secondary: ids[1] ?? null, fallback: ids[2] ?? null };
}

/** Model card in the house picker style (mirrors ModelPicker's
 *  ModelOption), extended with a chain-position badge. */
function ModelCard({ model, badge, onClick, footer }: {
  model: KieModel;
  badge: string | null;
  onClick: () => void;
  footer?: React.ReactNode;
}) {
  const selected = badge !== null;
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left p-3 rounded-xl transition-all cursor-pointer"
      style={selected ? {
        background: "oklch(0.72 0.25 285 / 0.1)",
        border: "1px solid oklch(0.72 0.25 285 / 0.35)",
        color: "var(--c-90)",
      } : {
        background: "var(--bg-input)",
        border: "1px solid var(--bd-7)",
        color: "var(--c-60)",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium text-xs">{model.name}</p>
        {selected && (
          <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wide"
            style={{ background: "oklch(0.72 0.25 285)", color: "white" }}>
            {badge}
          </span>
        )}
      </div>
      {model.description && <p className="text-xs mt-0.5 opacity-60">{model.description}</p>}
      {(model.tags?.length || model.costPerUnit) && (
        <div className="flex gap-1 mt-2 flex-wrap">
          {model.tags?.map((tag) => (
            <span key={tag} className="px-1.5 py-0.5 rounded text-xs"
              style={{ background: "var(--bg-track)", color: "var(--c-45)" }}>
              {tag}
            </span>
          ))}
          {model.costPerUnit && (
            <span className="px-1.5 py-0.5 rounded text-xs"
              style={{ background: "oklch(0.72 0.25 285 / 0.12)", color: "oklch(0.72 0.25 285)" }}>
              {model.costPerUnit} cr{model.type === "video" ? "/s" : ""}
            </span>
          )}
        </div>
      )}
      {footer}
    </button>
  );
}

/** Click models in order to build the fallback chain: 1st = Primary,
 *  2nd = Secondary, 3rd = Final fallback. Clicking a selected card
 *  removes it and the rest shift up. */
function ChainGrid({ title, models, chain, onChange }: {
  title: string;
  models: KieModel[] | undefined;
  chain: ModelChain;
  onChange: (c: { primary: string; secondary: string | null; fallback: string | null }) => void;
}) {
  const ids = chainToList(chain);
  function toggle(id: string) {
    const at = ids.indexOf(id);
    if (at >= 0) onChange(listToChain(ids.filter((x) => x !== id)));
    else if (ids.length < 3) onChange(listToChain([...ids, id]));
    else toast.info("Chain is full — remove one to swap");
  }
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-base font-bold" style={{ color: "var(--c-90)" }}>{title}</h2>
        <p className="text-xs mt-1" style={{ color: "var(--c-45)" }}>
          Click up to three in order — 1st is Primary, 2nd Secondary, 3rd Final fallback. If a model fails
          mid-run, 1Click automatically retries with the next one.
        </p>
      </div>
      <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {(models ?? []).map((m) => {
          const at = ids.indexOf(m.id);
          return (
            <ModelCard key={m.id} model={m} badge={at >= 0 ? CHAIN_BADGES[at] : null} onClick={() => toggle(m.id)} />
          );
        })}
      </div>
    </section>
  );
}

// Full-page 1Click preferences editor — lives on the Setup page's
// 1Click tab. One preset per user; runs snapshot it at kickoff.
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

  // Voice preview player — one at a time.
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  function togglePreview(v: KieModel) {
    if (playingVoice === v.id) {
      audioRef.current?.pause();
      setPlayingVoice(null);
      return;
    }
    if (!v.previewUrl) return;
    audioRef.current?.pause();
    const a = new Audio(v.previewUrl);
    a.onended = () => setPlayingVoice(null);
    a.play().catch(() => setPlayingVoice(null));
    audioRef.current = a;
    setPlayingVoice(v.id);
  }
  useEffect(() => () => audioRef.current?.pause(), []);

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

  const pill = (active: boolean) => ({
    background: active ? "oklch(0.72 0.25 285 / 0.12)" : "var(--bg-progress)",
    border: `1px solid ${active ? "oklch(0.72 0.25 285 / 0.35)" : "var(--bd-8)"}`,
    color: active ? "oklch(0.72 0.25 285)" : "var(--c-55)",
  });

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

      {/* Voice */}
      <section className="space-y-3">
        <div>
          <h2 className="text-base font-bold" style={{ color: "var(--c-90)" }}>Voiceover voice</h2>
          <p className="text-xs mt-1" style={{ color: "var(--c-45)" }}>Every 1Click video narrates with this voice.</p>
        </div>
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {(voices ?? []).map((v) => (
            <ModelCard
              key={v.id}
              model={v}
              badge={cfg.tts.voiceId === v.id ? "Selected" : null}
              onClick={() => setCfg({ ...cfg, tts: { modelId: v.id, voiceId: v.id } })}
              footer={v.previewUrl ? (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); togglePreview(v); }}
                  onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); togglePreview(v); } }}
                  className="inline-flex items-center gap-1.5 mt-2 px-2 py-1 rounded-lg text-[11px] font-semibold cursor-pointer"
                  style={{ background: "var(--bg-track)", color: "var(--c-55)" }}
                >
                  {playingVoice === v.id ? <Square size={10} /> : <Play size={10} />}
                  {playingVoice === v.id ? "Stop" : "Preview"}
                </span>
              ) : undefined}
            />
          ))}
        </div>
      </section>

      {/* Output format */}
      <section className="space-y-3">
        <div>
          <h2 className="text-base font-bold" style={{ color: "var(--c-90)" }}>Output format</h2>
          <p className="text-xs mt-1" style={{ color: "var(--c-45)" }}>
            One format for everything — images, clips, and the final video — so nothing gets letterboxed.
          </p>
        </div>
        <div className="flex gap-6 flex-wrap">
          <div>
            <label className={labelCls} style={labelStyle}>Aspect ratio</label>
            <div className="flex gap-2">
              {ASPECT_RATIOS.map((r) => (
                <button key={r} type="button" onClick={() => setCfg({ ...cfg, output: { ...cfg.output, aspectRatio: r } })}
                  className="px-4 py-2 rounded-xl text-sm font-medium transition-all cursor-pointer" style={pill(cfg.output.aspectRatio === r)}>
                  {r}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className={labelCls} style={labelStyle}>Resolution</label>
            <div className="flex gap-2">
              {RESOLUTIONS.map((r) => (
                <button key={r} type="button" onClick={() => setCfg({ ...cfg, output: { ...cfg.output, resolution: r } })}
                  className="px-4 py-2 rounded-xl text-sm font-medium transition-all cursor-pointer" style={pill(cfg.output.resolution === r)}>
                  {r}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <ChainGrid title="Image models" models={imageModels} chain={cfg.images}
        onChange={(images) => setCfg({ ...cfg, images })} />
      <ChainGrid title="Video models" models={videoModels} chain={cfg.videos}
        onChange={(videos) => setCfg({ ...cfg, videos })} />

      {/* Assembly */}
      <section className="space-y-4">
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
