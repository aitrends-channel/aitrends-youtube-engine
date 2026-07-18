"use client";

import { useEffect, useMemo, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { X, Zap } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import type { OneClickConfig } from "@/lib/one-click/config";
import { emptyConfig } from "@/lib/one-click/config";
import type { KieModel } from "@/lib/types";

const fetcher = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));

// Corner presets → logo position fractions. Fractions match the
// assemble page's logoX/logoY semantics (top-left of the logo).
const LOGO_POSITIONS: { id: string; label: string; x: number; y: number }[] = [
  { id: "tl", label: "Top left",     x: 0.02, y: 0.02 },
  { id: "tr", label: "Top right",    x: 0.88, y: 0.02 },
  { id: "bl", label: "Bottom left",  x: 0.02, y: 0.88 },
  { id: "br", label: "Bottom right", x: 0.88, y: 0.88 },
];

const ASPECT_RATIOS = ["16:9", "9:16", "1:1"];
const RESOLUTIONS = ["1080p", "2K"];

// 1Click preferences editor. Opens the first time a user picks 1Click
// (and from anywhere a "1Click settings" affordance exists). Saves one
// preset per user; a run snapshots the preset at kickoff.
export function OneClickSetup({ open, onClose, onSaved }: {
  open: boolean;
  onClose: () => void;
  /** Called after a successful save — the kickoff flow continues here. */
  onSaved: (config: OneClickConfig) => void;
}) {
  const { data: cfgData } = useSWR<{ configured: boolean; config: OneClickConfig }>(
    open ? "/api/one-click/config" : null, fetcher,
  );
  const { data: voices } = useSWR<KieModel[]>(open ? "/api/kie/models?type=tts" : null, fetcher);
  const { data: imageModels } = useSWR<KieModel[]>(open ? "/api/kie/models?type=image" : null, fetcher);
  const { data: videoModels } = useSWR<KieModel[]>(open ? "/api/kie/models?type=video" : null, fetcher);

  const [cfg, setCfg] = useState<OneClickConfig>(emptyConfig());
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);

  // Hydrate the form once per open: saved config wins; otherwise
  // prefill model chains from the admin-promoted defaults (index 0)
  // so a fresh form is already sensible.
  useEffect(() => {
    if (!open) { setHydrated(false); return; }
    if (hydrated || !cfgData) return;
    const base = cfgData.config;
    const withDefaults: OneClickConfig = {
      ...base,
      tts: {
        ...base.tts,
        voiceId: base.tts.voiceId || voices?.[0]?.id || "",
        modelId: base.tts.modelId || voices?.[0]?.id || "",
      },
      images: { ...base.images, primary: base.images.primary || imageModels?.[0]?.id || "" },
      videos: { ...base.videos, primary: base.videos.primary || videoModels?.[0]?.id || "" },
    };
    setCfg(withDefaults);
    if (cfgData && voices && imageModels && videoModels) setHydrated(true);
  }, [open, hydrated, cfgData, voices, imageModels, videoModels]);

  const logoPosId = useMemo(() => {
    const match = LOGO_POSITIONS.find((p) => Math.abs(p.x - cfg.assemble.logoX) < 0.01 && Math.abs(p.y - cfg.assemble.logoY) < 0.01);
    return match?.id ?? "tl";
  }, [cfg.assemble.logoX, cfg.assemble.logoY]);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/one-click/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(cfg),
      });
      const d = (await res.json().catch(() => ({}))) as { error?: string; config?: OneClickConfig };
      if (!res.ok) throw new Error(d.error ?? `Save failed (${res.status})`);
      toast.success("1Click preferences saved");
      onSaved(d.config ?? cfg);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  const selectCls = "w-full px-3 py-2 rounded-lg text-sm bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400 outline-none";
  const labelCls = "block text-xs font-semibold uppercase tracking-wider text-zinc-500 mb-1.5";
  const sectionCls = "text-sm font-bold text-zinc-900 mb-3";

  function ChainPicker({ label, models, chain, onChange }: {
    label: string;
    models: KieModel[] | undefined;
    chain: { primary: string; secondary?: string | null; fallback?: string | null };
    onChange: (c: { primary: string; secondary: string | null; fallback: string | null }) => void;
  }) {
    const opts = models ?? [];
    const slot = (key: "primary" | "secondary" | "fallback", title: string, optional: boolean) => (
      <div className="flex-1 min-w-[150px]">
        <label className={labelCls}>{title}</label>
        <select
          className={selectCls}
          value={(chain[key] as string | null | undefined) ?? ""}
          onChange={(e) => onChange({
            primary: chain.primary,
            secondary: chain.secondary ?? null,
            fallback: chain.fallback ?? null,
            [key]: e.target.value || null,
          } as { primary: string; secondary: string | null; fallback: string | null })}
        >
          {optional && <option value="">None</option>}
          {opts.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </div>
    );
    return (
      <div>
        <p className={sectionCls}>{label}</p>
        <p className="text-xs text-zinc-500 -mt-2 mb-3">
          If the primary model fails, 1Click automatically retries with the next one.
        </p>
        <div className="flex gap-3 flex-wrap">
          {slot("primary", "Primary", false)}
          {slot("secondary", "Secondary", true)}
          {slot("fallback", "Final fallback", true)}
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4" style={{ background: "oklch(0 0 0 / 0.55)" }}>
      {/* House rule: modals are white regardless of app theme. */}
      <div className="bg-white text-zinc-900 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[88vh] flex flex-col">
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-100">
          <div className="flex items-center gap-2.5">
            <span className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "oklch(0.72 0.25 285 / 0.12)" }}>
              <Zap size={15} style={{ color: "oklch(0.55 0.2 285)" }} />
            </span>
            <div>
              <h2 className="text-base font-bold">1Click Setup</h2>
              <p className="text-xs text-zinc-500">Your defaults for fully automatic videos — saved once, reused every run.</p>
            </div>
          </div>
          <button onClick={onClose} disabled={saving} className="p-1.5 rounded-lg hover:bg-zinc-100 cursor-pointer disabled:opacity-40">
            <X size={16} className="text-zinc-500" />
          </button>
        </div>

        <div className="px-6 py-5 space-y-7 overflow-y-auto">
          {/* Voice */}
          <div>
            <p className={sectionCls}>Voiceover</p>
            <label className={labelCls}>Voice</label>
            <select
              className={selectCls}
              value={cfg.tts.voiceId}
              onChange={(e) => setCfg({ ...cfg, tts: { modelId: e.target.value, voiceId: e.target.value } })}
            >
              {(voices ?? []).map((v) => (
                <option key={v.id} value={v.id}>{v.name}{v.tags?.length ? ` — ${v.tags.join(", ")}` : ""}</option>
              ))}
            </select>
          </div>

          {/* Output format */}
          <div>
            <p className={sectionCls}>Output format</p>
            <p className="text-xs text-zinc-500 -mt-2 mb-3">
              One format for everything — images, clips, and the final video — so nothing gets letterboxed.
            </p>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className={labelCls}>Aspect ratio</label>
                <select className={selectCls} value={cfg.output.aspectRatio}
                  onChange={(e) => setCfg({ ...cfg, output: { ...cfg.output, aspectRatio: e.target.value } })}>
                  {ASPECT_RATIOS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div className="flex-1">
                <label className={labelCls}>Resolution</label>
                <select className={selectCls} value={cfg.output.resolution}
                  onChange={(e) => setCfg({ ...cfg, output: { ...cfg.output, resolution: e.target.value } })}>
                  {RESOLUTIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
            </div>
          </div>

          <ChainPicker label="Image models" models={imageModels} chain={cfg.images}
            onChange={(images) => setCfg({ ...cfg, images })} />
          <ChainPicker label="Video models" models={videoModels} chain={cfg.videos}
            onChange={(videos) => setCfg({ ...cfg, videos })} />

          {/* Assembly */}
          <div>
            <p className={sectionCls}>Assembly</p>
            <div className="space-y-4">
              <label className="flex items-center gap-2.5 text-sm cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={cfg.assemble.captionsEnabled}
                  onChange={(e) => setCfg({ ...cfg, assemble: { ...cfg.assemble, captionsEnabled: e.target.checked } })}
                  className="accent-zinc-800"
                />
                Burn in captions
              </label>

              <div>
                <label className={labelCls}>Background music URL <span className="normal-case font-normal">(optional — direct link to an mp3)</span></label>
                <div className="flex gap-3 items-center">
                  <input
                    type="url"
                    className={`${selectCls} flex-1`}
                    placeholder="https://…/track.mp3 — leave empty for no music"
                    value={cfg.assemble.bgMusicUrl ?? ""}
                    onChange={(e) => setCfg({ ...cfg, assemble: { ...cfg.assemble, bgMusicUrl: e.target.value || null } })}
                  />
                  <div className="w-36 shrink-0">
                    <label className={labelCls}>Volume {Math.round(cfg.assemble.bgMusicVolume * 100)}%</label>
                    <input type="range" min={0} max={100}
                      value={Math.round(cfg.assemble.bgMusicVolume * 100)}
                      onChange={(e) => setCfg({ ...cfg, assemble: { ...cfg.assemble, bgMusicVolume: Number(e.target.value) / 100 } })}
                      className="w-full accent-zinc-800"
                    />
                  </div>
                </div>
              </div>

              <div className="flex gap-3 items-end flex-wrap">
                <div className="flex-1 min-w-[220px]">
                  <label className={labelCls}>Logo URL <span className="normal-case font-normal">(optional)</span></label>
                  <input
                    type="url"
                    className={selectCls}
                    placeholder="https://…/logo.png — leave empty for no logo"
                    value={cfg.assemble.logoUrl ?? ""}
                    onChange={(e) => setCfg({ ...cfg, assemble: { ...cfg.assemble, logoUrl: e.target.value || null } })}
                  />
                </div>
                <div className="w-44 shrink-0">
                  <label className={labelCls}>Logo position</label>
                  <select className={selectCls} value={logoPosId}
                    onChange={(e) => {
                      const p = LOGO_POSITIONS.find((x) => x.id === e.target.value) ?? LOGO_POSITIONS[0];
                      setCfg({ ...cfg, assemble: { ...cfg.assemble, logoX: p.x, logoY: p.y } });
                    }}>
                    {LOGO_POSITIONS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2.5 px-6 py-4 border-t border-zinc-100">
          <button
            onClick={onClose}
            disabled={saving}
            className="px-4 py-2 rounded-xl text-sm font-semibold text-zinc-600 hover:bg-zinc-100 cursor-pointer disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={saving || !cfg.tts.voiceId || !cfg.images.primary || !cfg.videos.primary}
            className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold text-white cursor-pointer disabled:opacity-40 transition-opacity hover:opacity-90"
            style={{ background: "oklch(0.55 0.2 285)" }}
          >
            {saving ? (<><Spinner size={13} className="text-white" /> Saving…</>) : "Save 1Click Setup"}
          </button>
        </div>
      </div>
    </div>
  );
}
