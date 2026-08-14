"use client";

import { useEffect, useState, type ReactNode, useMemo } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Wand2, X, ArrowLeft, ArrowRight } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { ModelPicker } from "@/components/ModelPicker";
import { VoicePickerGrid } from "@/components/VoicePickerGrid";
import { AssembleSection } from "@/components/one-click/AssembleSection";
import { AI33_VOICES } from "@/lib/ai33/tts";
import type { OneClickConfig } from "@/lib/one-click/config";
import { emptyConfig } from "@/lib/one-click/config";
import type { KieModel } from "@/lib/types";
import { paidModelsOnly } from "@/lib/model-tier";

const fetcher = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));


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
              ? { background: "oklch(0.72 0.25 285 / 0.15)", color: "var(--accent-purple-text)" }
              : { color: "var(--c-55)" }}
          >
            {s.label}
            {value ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded font-bold"
                style={{ background: "oklch(0.72 0.25 285 / 0.2)", color: "var(--accent-purple-text)" }}>
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

// Labeled toggle row (title + description + switch), matching the
// captions toggle style. Used for the topic/script manual-vs-auto gates.
function SwitchRow({ title, desc, on, onToggle }: {
  title: string; desc: string; on: boolean; onToggle: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <h2 className="text-base font-bold" style={{ color: "var(--c-90)" }}>{title}</h2>
        <p className="text-xs mt-1 max-w-lg" style={{ color: "var(--c-45)" }}>{desc}</p>
      </div>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={on}
        className="relative w-11 h-6 rounded-full transition-all shrink-0 cursor-pointer"
        style={{ background: on ? "oklch(0.72 0.25 285)" : "var(--c-22)", border: "1px solid var(--bd-10)" }}
      >
        <span className="absolute top-0.5 w-5 h-5 rounded-full transition-all"
          style={{ background: "oklch(0.95 0 0)", left: on ? "calc(100% - 1.375rem)" : "0.125rem" }} />
      </button>
    </div>
  );
}

// 1Click preferences editor, in two shapes over one set of sections:
//
//   "all"     — every section stacked with a sticky save bar. The Setup
//               page's 1Click tab; unchanged behaviour.
//   "stepper" — one section per screen with Back/Next. Used by the 1Click
//               view so a user who hasn't configured 1Click yet does it
//               there instead of being sent off to the Setup page.
//
// Both modes render the SAME section nodes from `screens` below, so the
// two can't drift apart. Reuses the product's real pickers: the voiceover
// step's VoiceOption cards and the generate step's ModelPicker (tabs,
// search, cost/speed chips), wrapped in Primary/Secondary/Final-fallback
// slot tabs.
export function OneClickConfigPanel({
  mode = "all",
  onSaved,
}: {
  mode?: "all" | "stepper";
  /** Fired after a successful save — the stepper uses it to hand back to
   *  whatever comes next (starting the run, returning to the dashboard). */
  onSaved?: () => void;
}) {
  const { data: cfgData, mutate } = useSWR<{ configured: boolean; config: OneClickConfig }>(
    "/api/one-click/config", fetcher,
  );
  const { data: voices } = useSWR<KieModel[]>("/api/kie/models?type=tts", fetcher);
  const { data: imageModels } = useSWR<KieModel[]>("/api/kie/models?type=image", fetcher);
  const { data: rawVideoModels } = useSWR<KieModel[]>("/api/kie/models?type=video", fetcher);
  // 1Click queues clips into "queued" like any KIE clip, and a free clip has to
  // be parked where the shared video-worker cannot claim it. Offering a free
  // model here would produce beats that worker sends to KIE, so the option is
  // absent rather than broken. Free clips are chosen from the picker's Free tab
  // on the Generate step.
  const videoModels = useMemo(() => (rawVideoModels ? paidModelsOnly(rawVideoModels) : rawVideoModels), [rawVideoModels]);

  const [cfg, setCfg] = useState<OneClickConfig>(emptyConfig());
  const [hydrated, setHydrated] = useState(false);
  const [saving, setSaving] = useState(false);
  const [playingVoice, setPlayingVoice] = useState<string | null>(null);
  const [imageSlot, setImageSlot] = useState<ChainSlot>("primary");
  const [videoSlot, setVideoSlot] = useState<ChainSlot>("primary");
  const [step, setStep] = useState(0);
  // True while a screen's beforeNext gate is running (a channel lookup).
  const [advancing, setAdvancing] = useState(false);

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
      await mutate();
      onSaved?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const canSave = Boolean(cfg.tts.voiceId && cfg.images.primary && cfg.videos.primary);

  // Free (ai33 perk) voices get their own tab in the picker, mirroring the
  // voiceover step, so a 1Click run can narrate on the perk instead of the
  // user's own credit. Nothing server-side needs changing: the orchestrator
  // calls the same generateTTS, which routes on the "ai33/" prefix.
  //
  // Only ai33 is offered, matching what the voiceover step's Free tab
  // actually exposes today — BYO Google needs the user's own key and Qwen
  // is currently hidden behind a flag.
  const freeVoices = AI33_VOICES;

  const sectionStyle = { background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.14)" } as const;

  // One entry per screen. `ready` gates Next in stepper mode so the user
  // can't walk past a choice the config can't be saved without.
  const screens: { id: string; title: string; hint: string; ready: boolean; node: ReactNode; beforeNext?: () => Promise<boolean> }[] = [
    {
      id: "contentType",
      title: "Content type",
      hint: "What kind of videos should 1Click make?",
      ready: true,
      node: (
        <section key="contentType" className="space-y-5 p-6 sm:p-8 rounded-2xl" style={sectionStyle}>
          <div>
            <h2 className="text-base font-bold" style={{ color: "var(--c-90)" }}>What kind of videos?</h2>
            <p className="text-xs mt-1" style={{ color: "var(--c-45)" }}>
              This shapes the whole pipeline, from transcripts to the final cut. Every 1Click run uses it.
            </p>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {([
              { value: "long" as const, label: "Long-form", desc: "Standard landscape videos." },
              { value: "shorts" as const, label: "Shorts", desc: "Vertical short-form clips." },
              { value: "both" as const, label: "Both", desc: "A mix of long-form and shorts." },
            ]).map((t) => {
              const active = (cfg.contentType ?? "long") === t.value;
              return (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setCfg({ ...cfg, contentType: t.value })}
                  className="text-left px-3.5 py-2.5 rounded-xl transition-all hover:opacity-90 cursor-pointer"
                  style={active
                    ? { background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.45)" }
                    : { background: "var(--bg-input)", border: "1px solid var(--bd-10)" }}
                >
                  <span className="block text-sm font-semibold"
                    style={{ color: active ? "var(--accent-purple-text)" : "var(--c-90)" }}>
                    {t.label}
                  </span>
                  <span className="block text-xs mt-0.5" style={{ color: "var(--c-45)" }}>{t.desc}</span>
                </button>
              );
            })}
          </div>
        </section>
      ),
    },
    {
      id: "gates",
      title: "Topic & script",
      hint: "Choose which steps 1Click should pause on for your input.",
      ready: true,
      node: (
        <section key="gates" className="space-y-5 p-6 sm:p-8 rounded-2xl" style={sectionStyle}>
          <SwitchRow
            title="Manually select topic?"
            desc="Turn this on to pick the topic yourself from the generated ideas. Leave it off and 1Click picks the top idea and keeps going."
            on={cfg.topicMode === "manual"}
            onToggle={() => setCfg({ ...cfg, topicMode: cfg.topicMode === "manual" ? "auto" : "manual" })}
          />
          <div style={{ borderTop: "1px solid var(--bd-6)" }} />
          <SwitchRow
            title="Write the script myself?"
            desc="Turn this on to write or edit the script yourself. Leave it off and 1Click writes the script with AI and keeps going."
            on={cfg.scriptMode === "manual"}
            onToggle={() => setCfg({ ...cfg, scriptMode: cfg.scriptMode === "manual" ? "auto" : "manual" })}
          />
        </section>
      ),
    },
    {
      id: "length",
      title: "Script length",
      hint: "Use the whole script, or just the opening words for shorter videos.",
      ready: true,
      node: (
        <section key="length" className="space-y-5 p-6 sm:p-8 rounded-2xl" style={sectionStyle}>
          {/* Temporary: this whole screen is a testing affordance for
              short/cheap runs and comes out once we're done with it. */}
          <p className="rounded-xl px-4 py-2.5 text-xs font-semibold"
            style={{
              background: "oklch(0.6 0.22 25 / 0.1)",
              color: "oklch(0.7 0.2 25)",
              border: "1px solid oklch(0.6 0.22 25 / 0.2)",
            }}>
            This step is for testing only, will be removed.
          </p>
          <SwitchRow
            title="Use the full script?"
            desc="Turn this on to use the whole script. Leave it off to use only the first few words you set below, which makes shorter, cheaper videos."
            on={cfg.scriptLimit?.fullScript ?? false}
            onToggle={() => setCfg({ ...cfg, scriptLimit: { fullScript: !(cfg.scriptLimit?.fullScript ?? false), words: cfg.scriptLimit?.words ?? 20 } })}
          />
          {!(cfg.scriptLimit?.fullScript ?? false) && (
            <>
              <div style={{ borderTop: "1px solid var(--bd-6)" }} />
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-base font-bold" style={{ color: "var(--c-90)" }}>Script length</h2>
                  <p className="text-xs mt-1 max-w-lg" style={{ color: "var(--c-45)" }}>Number of words from the start of the script to use for the whole video.</p>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={cfg.scriptLimit?.words ?? 20}
                    onChange={(e) => {
                      const n = Math.max(1, Math.floor(Number(e.target.value) || 0));
                      setCfg({ ...cfg, scriptLimit: { fullScript: false, words: n } });
                    }}
                    className="w-24 px-3 py-2 rounded-lg text-sm outline-none text-right"
                    style={{ background: "oklch(1 0 0 / 0.06)", border: "1px solid var(--bd-10)", color: "var(--c-90)" }}
                  />
                  <span className="text-sm" style={{ color: "var(--c-45)" }}>words</span>
                </div>
              </div>
            </>
          )}
        </section>
      ),
    },
    {
      id: "voice",
      title: "Voiceover voice",
      hint: "Every 1Click video narrates with this voice. Free voices are included.",
      ready: Boolean(cfg.tts.voiceId),
      node: (
        <section key="voice" className="space-y-5 p-6 sm:p-8 rounded-2xl" style={sectionStyle}>
          <div>
            <h2 className="text-base font-bold" style={{ color: "var(--c-90)" }}>Voiceover voice</h2>
            <p className="text-xs mt-1" style={{ color: "var(--c-45)" }}>
              Every 1Click video narrates with this voice. Voices marked free run on your
              monthly Heclus allowance instead of your own credit.
            </p>
          </div>
          <VoicePickerGrid
            voices={voices}
            freeVoices={freeVoices}
            selectedId={cfg.tts.voiceId || null}
            onSelect={(id) => setCfg({ ...cfg, tts: { modelId: id, voiceId: id } })}
            playingId={playingVoice}
            onPlayToggle={setPlayingVoice}
          />
        </section>
      ),
    },
    {
      id: "images",
      title: "Image models",
      hint: "Pick up to three. If one fails, 1Click tries the next.",
      ready: Boolean(cfg.images.primary),
      node: (
        <section key="images" className="space-y-5 p-6 sm:p-8 rounded-2xl" style={sectionStyle}>
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
      ),
    },
    {
      id: "videos",
      title: "Video models",
      hint: "Clips inherit the image aspect ratio you chose.",
      ready: Boolean(cfg.videos.primary),
      node: (
        <section key="videos" className="space-y-5 p-6 sm:p-8 rounded-2xl" style={sectionStyle}>
          <div className="space-y-2.5">
            <h2 className="text-base font-bold" style={{ color: "var(--c-90)" }}>Video models</h2>
            <div className="rounded-xl px-4 py-3 text-sm leading-relaxed"
              style={{
                background: "oklch(0.72 0.25 285 / 0.08)",
                border: "1px solid oklch(0.72 0.25 285 / 0.25)",
                color: "var(--c-80)",
              }}>
              Pick your 3 preferred models: clips inherit the image aspect ratio.
            </div>
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
      ),
    },
    {
      id: "assembly",
      title: "Assembly",
      hint: "Applied when 1Click stitches the final video.",
      ready: true,
      node: (
        <section key="assembly" className="space-y-5 p-6 sm:p-8 rounded-2xl" style={sectionStyle}>
          <div>
            <h2 className="text-base font-bold" style={{ color: "var(--c-90)" }}>Assembly</h2>
            <p className="text-xs mt-1" style={{ color: "var(--c-45)" }}>Applied when 1Click stitches the final video.</p>
          </div>
          <AssembleSection
            value={cfg.assemble}
            aspectRatio={cfg.output.aspectRatio}
            onChange={(assemble) => setCfg({ ...cfg, assemble })}
          />
        </section>
      ),
    },
    {
      id: "notifications",
      title: "Email notifications",
      hint: "Choose when 1Click emails you about a run.",
      ready: true,
      node: (
        <section key="notifications" className="space-y-5 p-6 sm:p-8 rounded-2xl" style={sectionStyle}>
          <div>
            <h2 className="text-base font-bold" style={{ color: "var(--c-90)" }}>Email notifications</h2>
            <p className="text-xs mt-1" style={{ color: "var(--c-45)" }}>Choose when 1Click emails you about a run.</p>
          </div>
          <SwitchRow
            title="Notify me when input is needed or something fails?"
            desc="Get an email whenever a run stops for your input or hits an error."
            on={cfg.notifications?.onAttention ?? true}
            onToggle={() => setCfg({ ...cfg, notifications: { onAttention: !(cfg.notifications?.onAttention ?? true), onComplete: cfg.notifications?.onComplete ?? true } })}
          />
          <div style={{ borderTop: "1px solid var(--bd-6)" }} />
          <SwitchRow
            title="Notify me when the video is ready?"
            desc="Get an email as soon as your final video is ready to review."
            on={cfg.notifications?.onComplete ?? true}
            onToggle={() => setCfg({ ...cfg, notifications: { onAttention: cfg.notifications?.onAttention ?? true, onComplete: !(cfg.notifications?.onComplete ?? true) } })}
          />
        </section>
      ),
    },
  ];

  // ── Stepper: one screen after the other ────────────────────────────────
  if (mode === "stepper") {
    const allScreens = screens;
    const idx = Math.min(step, allScreens.length - 1);
    const current = allScreens[idx];
    const isLast = idx === allScreens.length - 1;

    async function goNext() {
      if (current.beforeNext) {
        setAdvancing(true);
        try {
          const ok = await current.beforeNext();
          if (!ok) return;
        } finally {
          setAdvancing(false);
        }
      }
      setStep((v) => Math.min(allScreens.length - 1, v + 1));
    }
    return (
      <div className="space-y-6">
        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-45)" }}>
            Step {idx + 1} of {allScreens.length}
          </p>
          <div>
            <h2 className="text-xl font-bold" style={{ color: "var(--c-90)" }}>{current.title}</h2>
            <p className="text-xs mt-1" style={{ color: "var(--c-45)" }}>{current.hint}</p>
          </div>
          {/* Segmented progress — one bar per screen. */}
          <div className="flex items-center gap-1.5">
            {allScreens.map((s, i) => (
              <span key={s.id} className="h-1 flex-1 rounded-full transition-all"
                style={{ background: i <= idx ? "oklch(0.72 0.25 285)" : "var(--bg-track)" }} />
            ))}
          </div>
        </div>

        {current.node}

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => setStep((s) => Math.max(0, s - 1))}
            disabled={idx === 0 || saving || advancing}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-medium transition-all hover:opacity-80 disabled:opacity-30 cursor-pointer"
            style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-card)", color: "var(--c-70)" }}
          >
            <ArrowLeft size={14} /> Back
          </button>
          <span className="flex-1" />
          {isLast ? (
            <button
              type="button"
              onClick={save}
              disabled={saving || !canSave}
              title={canSave ? undefined : "Pick a voice, a primary image model and a primary video model first"}
              className="inline-flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-40 cursor-pointer"
              style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
            >
              {saving ? (<><Spinner size={13} /> Saving…</>) : "Finish setup"}
            </button>
          ) : (
            <button
              type="button"
              onClick={goNext}
              disabled={!current.ready || advancing}
              title={current.ready ? undefined : "Make a choice on this screen to continue"}
              className="inline-flex items-center gap-1.5 px-6 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-40 cursor-pointer"
              style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
            >
              {advancing ? (<><Spinner size={13} /> Checking…</>) : (<>Next <ArrowRight size={14} /></>)}
            </button>
          )}
        </div>
      </div>
    );
  }

  // ── All-at-once: the Setup page's 1Click tab ───────────────────────────
  return (
    <div className="space-y-10 pb-28">
      {/* Heading */}
      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
            style={{ background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
            <Wand2 size={18} style={{ color: "var(--brand-text)" }} />
          </div>
          <h1 className="text-2xl font-bold text-foreground">1Click</h1>
        </div>
        <p className="text-sm leading-relaxed max-w-2xl" style={{ color: "var(--c-50)" }}>
          Your defaults for fully automatic videos. Set them once and every 1Click run uses these choices at
          each step. Videos already running keep the settings they started with.
        </p>
        {cfgData && !cfgData.configured && (
          <p className="text-xs font-semibold px-3 py-2 rounded-lg inline-block"
            style={{ background: "oklch(0.72 0.18 65 / 0.12)", color: "var(--accent-amber-text)", border: "1px solid oklch(0.72 0.18 65 / 0.3)" }}>
            Not configured yet. Pick your preferences below and save to unlock 1Click.
          </p>
        )}
      </div>

      {screens.map((s) => s.node)}

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
