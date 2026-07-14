"use client";

import { useState, useEffect } from "react";
import { Search } from "lucide-react";
import type { KieModel } from "@/lib/types";
import { getModelConfig, FREE_IMAGE_MODELS } from "@/lib/kie/imageModels";
import { getVideoModelConfig } from "@/lib/kie/videoModels";
import { FREE_TIER_COMING_SOON } from "@/lib/free-tier-flag";

// Shared model + variant selector used wherever the user picks an
// image or video model. Lives in one place so every step in the
// workflow (generate, thumbnails, any future use) renders the same
// All / Fastest / Cheapest tabs + ModelOption cards + aspect-ratio /
// resolution / duration buttons. Discriminated by `type` so the
// variant section knows whether to show resolutions (image) or
// durations (video).

type ModelTab = "all" | "fastest" | "cheapest" | "free";

// Fallback cap shown before /api/free-usage responds (the response's
// imageCap wins once it lands). Kept local so this client component
// doesn't import the server-only freeUsage lib (service-role client).
const FREE_IMAGE_DAILY_CAP_UI = 500;

interface CommonProps {
  models: KieModel[] | undefined;
  selectedModelId: string | null;
  onSelectModel: (id: string) => void;
  selectedAspectRatio: string;
  onSelectAspectRatio: (r: string) => void;
  disabled?: boolean;
  /** Render the aspect ratio as a read-only value instead of selectable
   *  pills. Used by the video panel, where the clip must inherit the
   *  aspect ratio the source image was generated with rather than let
   *  the user pick a mismatching one. */
  lockAspectRatio?: boolean;
  /** Hide the aspect-ratio section entirely (no selector, no read-only
   *  value). Used by the video panel: the clip inherits the source
   *  image's ratio, so there's nothing for the user to see or set. */
  hideAspectRatio?: boolean;
  /** Override the "Tip: if a model keeps failing…" hint, or pass an
   *  empty string to hide it entirely. */
  tip?: string;
}

interface ImageModelPickerProps extends CommonProps {
  type: "image";
  selectedResolution: string | null;
  onSelectResolution: (r: string | null) => void;
}

interface VideoModelPickerProps extends CommonProps {
  type: "video";
  selectedDuration: string | number;
  onSelectDuration: (d: string | number) => void;
  selectedResolution: string | null;
  onSelectResolution: (r: string | null) => void;
}

export type ModelPickerProps = ImageModelPickerProps | VideoModelPickerProps;

function ModelOption({
  model,
  selected,
  disabled,
  onSelect,
  footer,
}: {
  model: KieModel;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  /** Optional content rendered inside the card, below the tags. */
  footer?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className="w-full text-left p-3 rounded-xl transition-all disabled:opacity-40 disabled:cursor-not-allowed"
      style={selected ? {
        background: "oklch(0.72 0.25 285 / 0.1)",
        border: "1px solid oklch(0.72 0.25 285 / 0.3)",
        color: "var(--c-90)",
      } : {
        background: "var(--bg-input)",
        border: "1px solid var(--bd-7)",
        color: "var(--c-60)",
      }}
    >
      <p className="font-medium text-xs">{model.name}</p>
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

function VariantPill<T>({
  label,
  selected,
  disabled,
  onClick,
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="px-2.5 py-1 rounded-lg text-xs font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed"
      style={selected ? {
        background: "oklch(0.72 0.25 285 / 0.15)",
        border: "1px solid oklch(0.72 0.25 285 / 0.4)",
        color: "oklch(0.88 0.12 285)",
      } : {
        background: "var(--bg-input)",
        border: "1px solid var(--bd-7)",
        color: "var(--c-50)",
      }}
    >
      {label}
    </button>
  );
}

export function ModelPicker(props: ModelPickerProps) {
  const { type, models, selectedModelId, onSelectModel, disabled = false } = props;
  const [tab, setTab] = useState<ModelTab>("all");
  const [query, setQuery] = useState("");

  // Free-tier daily usage, fetched when the Free image tab is open, to
  // drive the usage/progress bar.
  const [freeUsage, setFreeUsage] = useState<{ image: number; imageCap: number } | null>(null);
  useEffect(() => {
    if (tab !== "free" || type !== "image") return;
    let cancelled = false;
    const load = () =>
      fetch("/api/free-usage")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => { if (!cancelled && d) setFreeUsage(d as { image: number; imageCap: number }); })
        .catch(() => { /* bar just shows "…" — non-critical */ });
    load();
    // Poll while the Free tab is open so the bar reflects generations that
    // just happened (the picker gets no direct signal when a beat finishes).
    const id = setInterval(load, 5000);
    const onFocus = () => load();
    window.addEventListener("focus", onFocus);
    return () => { cancelled = true; clearInterval(id); window.removeEventListener("focus", onFocus); };
  }, [tab, type]);

  // Free-tier BYO key status, fetched when the Free tab opens, to gate the
  // tab behind "set up your free tools first" until the user has connected
  // their own Cloudflare (images) / Google Cloud TTS (voice) credentials.
  const [freeKeys, setFreeKeys] = useState<{ cloudflareSet: boolean; googleTtsSet: boolean } | null>(null);
  useEffect(() => {
    if (tab !== "free") return;
    let cancelled = false;
    fetch("/api/me/api-keys-status")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setFreeKeys({ cloudflareSet: !!d.cloudflareSet, googleTtsSet: !!d.googleTtsSet });
      })
      .catch(() => { /* leave null — don't gate on a failed check */ });
    return () => { cancelled = true; };
  }, [tab]);
  // For images we need Cloudflare; only gate once we know it's missing.
  const needsFreeSetup = tab === "free" && type === "image" && freeKeys !== null && !freeKeys.cloudflareSet;

  const searchQ = query.trim().toLowerCase();
  const matchesSearch = (m: KieModel) =>
    !searchQ ||
    m.name.toLowerCase().includes(searchQ) ||
    m.id.toLowerCase().includes(searchQ) ||
    (m.tags ?? []).some((t) => t.toLowerCase().includes(searchQ));

  // Sort the model list according to the active tab. Fastest/Cheapest
  // are ledger-driven and hide models without observed data so the tab
  // only shows ranked entries. "all" preserves the upstream order.
  const list: KieModel[] | null = (() => {
    if (!models) return null;
    const base = models.slice();
    if (tab === "fastest") {
      return base
        .filter((m) => typeof m.avgSpeedMs === "number" && m.avgSpeedMs > 0 && matchesSearch(m))
        .sort((a, b) => (a.avgSpeedMs ?? Infinity) - (b.avgSpeedMs ?? Infinity));
    }
    if (tab === "cheapest") {
      return base
        .filter((m) => m.costPerUnit !== undefined && m.costPerUnit !== null && matchesSearch(m))
        .sort((a, b) => Number(a.costPerUnit) - Number(b.costPerUnit));
    }
    return base.filter(matchesSearch);
  })();

  const empty = models && (
    tab === "fastest"
      ? !models.some((m) => typeof m.avgSpeedMs === "number" && m.avgSpeedMs > 0)
      : tab === "cheapest"
        ? !models.some((m) => m.costPerUnit !== undefined && m.costPerUnit !== null)
        : models.length === 0
  );
  const noSearchResults = !!models && !empty && searchQ.length > 0 && (list?.length ?? 0) === 0;

  // Discriminated per-type helpers so downstream JSX doesn't have to
  // re-narrow off `props.type`. A single unioned `config` variable
  // trips TS's "in" narrowing when both ModelConfig and VideoModelConfig
  // share an optional `resolutions` field.
  const imageConfig = type === "image" && selectedModelId ? getModelConfig(selectedModelId) : null;
  const videoConfig = type === "video" && selectedModelId ? getVideoModelConfig(selectedModelId) : null;
  const config = imageConfig ?? videoConfig;

  const tipText = props.tip
    ?? (type === "image"
      ? "Tip: if a model keeps failing, pick another above and re-run — successful images stay."
      : "Tip: if a model keeps failing, pick another above and re-queue — existing clips stay.");

  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>
        Select Model
      </p>

      <div className="flex gap-1 mb-2 p-0.5 rounded-lg" style={{ background: "var(--bg-track)" }}>
        {(["all", "fastest", "cheapest", "free"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            disabled={disabled}
            className="flex-1 flex items-center justify-center px-2 py-1 rounded-md text-xs font-medium capitalize transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            style={tab === t ? {
              background: "oklch(0.72 0.25 285 / 0.15)",
              color: "oklch(0.88 0.12 285)",
              boxShadow: "inset 0 0 0 1px oklch(0.72 0.25 285 / 0.35)",
            } : { background: "transparent", color: "var(--c-55)" }}
          >
            {t === "free" && FREE_TIER_COMING_SOON ? (
              <span className="flex flex-col items-center leading-tight">
                <span>😄 Free</span>
                <span className="text-[9px] font-semibold normal-case">coming soon</span>
              </span>
            ) : t}
          </button>
        ))}
      </div>

      {tab === "free" ? (
        FREE_TIER_COMING_SOON ? (
          // TEMPORARY (lib/free-tier-flag.ts): free tier paused — warm
          // "coming soon" card, same copy the tab originally shipped
          // with. The functional branches below stay intact for when
          // the flag flips back.
          <div className="rounded-xl px-4 py-8 text-center"
            style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)" }}>
            <p className="text-base font-bold" style={{ color: "var(--primary)" }}>
              Great Good News!
            </p>
            <p className="text-sm font-medium mt-2" style={{ color: "var(--c-70)" }}>
              Thank you for choosing us and for being part of our journey.
            </p>
            <p className="text-xs mt-1.5 leading-relaxed" style={{ color: "var(--c-45)" }}>
              We&apos;re building free resources to help you streamline your
              production, reduce costs, and achieve more with less. Stay with us
              as we continue to grow into the one-stop solution you&apos;ve been
              looking for.
            </p>
          </div>
        ) : type === "image" ? (
          // Free image models grouped under their provider (Cloudflare),
          // sharing one daily quota — they all draw from the same account's
          // free Neuron pool. A second provider would get its own section.
          needsFreeSetup ? (
            <FreeSetupPrompt />
          ) : (() => {
            const used = freeUsage?.image ?? 0;
            const cap = freeUsage?.imageCap ?? FREE_IMAGE_DAILY_CAP_UI;
            const pctRaw = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
            // Any nonzero usage gets at least a ~1% sliver so the green is
            // actually visible even at a handful of images out of the cap.
            const fillWidth = used > 0 ? Math.max(pctRaw, 1) : 0;
            const near = pctRaw >= 90;
            return (
              <div className="rounded-xl p-3 space-y-2.5 mt-[5px]" style={{ border: "1px solid var(--bd-card)" }}>
                {/* Section header: provider name (left) + shared daily-quota
                    usage bar (right). */}
                <div className="flex items-center justify-between gap-3">
                  <span className="text-xs font-semibold" style={{ color: "var(--c-55)" }}>Cloudflare</span>
                  <div className="w-[150px] shrink-0">
                    <div className="flex items-center justify-between text-[10px] mb-1">
                      <span style={{ color: "var(--c-45)" }}>Daily quota</span>
                      <span className="tabular-nums" style={{ color: "var(--c-45)" }}>
                        {freeUsage ? `${used} / ${cap}` : "…"}
                      </span>
                    </div>
                    <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--bg-track)" }}>
                      <div
                        className="h-full rounded-full transition-all"
                        style={{
                          width: `${fillWidth}%`,
                          background: near
                            ? "oklch(0.72 0.18 65)"
                            : "linear-gradient(90deg, oklch(0.7 0.19 150), oklch(0.6 0.2 145))",
                        }}
                      />
                    </div>
                  </div>
                </div>
                {FREE_IMAGE_MODELS.map((m) => (
                  <ModelOption
                    key={m.id}
                    model={m}
                    selected={selectedModelId === m.id}
                    disabled={disabled}
                    onSelect={() => onSelectModel(m.id)}
                  />
                ))}
              </div>
            );
          })()
        ) : (
          // No free video provider — video generation stays on paid models.
          <div className="rounded-xl px-4 py-8 text-center"
            style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)" }}>
            <p className="text-sm font-medium" style={{ color: "var(--c-70)" }}>
              Free video is coming soon.
            </p>
            <p className="text-xs mt-1.5 leading-relaxed" style={{ color: "var(--c-45)" }}>
              We&apos;re still working on it. Check back soon.
            </p>
          </div>
        )
      ) : (
      <>
      <div className="relative mb-2">
        <Search
          size={13}
          className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
          style={{ color: "var(--c-40)" }}
        />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${type} models…`}
          disabled={disabled}
          className="w-full pl-7 pr-2.5 py-1.5 rounded-lg text-xs outline-none disabled:opacity-40 focus:ring-1"
          style={{ background: "var(--bg-input)", border: "1px solid var(--bd-7)", color: "var(--c-70)" }}
        />
      </div>

      <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
        {list?.map((m) => (
          <ModelOption
            key={m.id}
            model={m}
            selected={selectedModelId === m.id}
            disabled={disabled}
            onSelect={() => onSelectModel(m.id)}
          />
        ))}
        {noSearchResults && (
          <p className="text-xs px-1 py-2" style={{ color: "var(--c-40)" }}>
            No {type} models match “{query.trim()}”.
          </p>
        )}
        {empty && tab === "fastest" && (
          <div className="text-xs px-1 py-2 space-y-1" style={{ color: "var(--c-40)" }}>
            <p className="font-medium" style={{ color: "var(--c-55)" }}>No speed data yet!</p>
            <p>Ranking is powered by real-time usage and will automatically populate as data comes in.</p>
          </div>
        )}
        {empty && tab === "cheapest" && (
          <div className="text-xs px-1 py-2 space-y-1" style={{ color: "var(--c-40)" }}>
            <p className="font-medium" style={{ color: "var(--c-55)" }}>No cost data yet!</p>
            <p>Ranking is powered by real-time usage and will automatically populate as data comes in.</p>
          </div>
        )}
        {empty && tab === "all" && (
          <p className="text-xs px-1 py-2" style={{ color: "var(--c-40)" }}>
            No {type} models available.
          </p>
        )}
        {!models && <p className="text-xs" style={{ color: "var(--c-40)" }}>Loading models...</p>}
      </div>

      {tipText && (
        <p className="text-[11px] mt-2 leading-snug" style={{ color: "var(--c-40)" }}>
          {tipText}
        </p>
      )}

      {/* Image aspect-ratio + resolution selectors were moved out of this
          non-free branch to below the tab ternary, so the Free tab shows
          them too (config-driven per selected model). */}

      {/* Video variant knobs — resolution/mode/quality on the left,
          duration on the right, in a single flex row so the two short
          pill lists sit side-by-side instead of stacking. When only
          one of the two is available, it takes the full row width.
          The KIE field name for the resolution knob varies (kling uses
          "mode", runway uses "quality", most use "resolution") but the
          picker treats them uniformly; submit code reads resolutionKey
          off the config to send under the right field. */}
      {props.type === "video" && videoConfig
        && ((videoConfig.resolutions && videoConfig.resolutions.length > 0) || videoConfig.durations.length > 0) && (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-3">
          {videoConfig.resolutions && videoConfig.resolutions.length > 0 && (
            <div className="flex-1 min-w-[140px]">
              <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>
                Resolution
              </p>
              <div className="flex flex-wrap gap-1.5">
                {videoConfig.resolutions.map((res) => (
                  <VariantPill
                    key={res}
                    label={res}
                    selected={props.selectedResolution === res}
                    disabled={disabled}
                    // Set-only, not toggle. Video models expect exactly
                    // one resolution — clicking the already-selected pill
                    // used to unset it and silently fall back to KIE's
                    // model default (e.g. Runway's 720p, Kling 3.0's
                    // "std"), which surfaced as "I picked 4K but got
                    // 720p" bugs. Duration pills already work this way.
                    onClick={() => props.onSelectResolution(res)}
                  />
                ))}
              </div>
            </div>
          )}
          {videoConfig.durations.length > 0 && (
            <div className="flex-1 min-w-[140px]">
              <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>
                Duration
              </p>
              <div className="flex flex-wrap gap-1">
                {videoConfig.durations.map((d) => (
                  <VariantPill
                    key={String(d.value)}
                    label={d.label}
                    selected={props.selectedDuration === d.value}
                    disabled={disabled}
                    onClick={() => props.onSelectDuration(d.value)}
                  />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
      </>
      )}

      {/* Aspect ratio + resolution — OUTSIDE the tab ternary so the Free tab
          gets them too. Config-driven per selected model: free SDXL offers
          16:9/1:1/9:16/4:3/3:4, free FLUX Schnell only 1:1, and Cloudflare
          free models have no resolution tiers (so that block stays hidden
          for them). */}
      {props.hideAspectRatio ? null : props.lockAspectRatio ? (
        <>
          <p className="text-xs font-semibold uppercase tracking-wider mt-4 mb-2" style={{ color: "var(--c-40)" }}>
            Aspect Ratio{" "}
            <span className="normal-case font-normal" style={{ color: "var(--c-35)" }}>· matches the image</span>
          </p>
          <span
            className="inline-flex px-2.5 py-1 rounded-lg text-xs font-medium"
            style={{
              background: "oklch(0.72 0.25 285 / 0.15)",
              border: "1px solid oklch(0.72 0.25 285 / 0.4)",
              color: "oklch(0.88 0.12 285)",
            }}
          >
            {props.selectedAspectRatio || "—"}
          </span>
        </>
      ) : config && config.aspectRatios.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-wider mt-4 mb-2" style={{ color: "var(--c-40)" }}>
            Aspect Ratio
          </p>
          <div className="flex flex-wrap gap-1.5">
            {config.aspectRatios.map((r) => (
              <VariantPill
                key={r}
                label={r}
                selected={props.selectedAspectRatio === r}
                disabled={disabled}
                onClick={() => props.onSelectAspectRatio(r)}
              />
            ))}
          </div>
        </>
      )}

      {props.type === "image" && imageConfig?.resolutions && imageConfig.resolutions.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-wider mt-3 mb-2" style={{ color: "var(--c-40)" }}>
            Resolution
          </p>
          <div className="flex flex-wrap gap-1.5">
            {imageConfig.resolutions.map((res) => (
              <VariantPill
                key={res}
                label={res}
                selected={props.selectedResolution === res}
                disabled={disabled}
                onClick={() => props.onSelectResolution(res === props.selectedResolution ? null : res)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// Shown on the Free tab when the user hasn't connected their own BYO
// free-tier credentials yet (Cloudflare for images). Sends them to the
// setup page instead of a picker that would 401 on the first generation.
function FreeSetupPrompt() {
  return (
    <div
      className="rounded-xl px-4 py-8 text-center"
      style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)" }}
    >
      <p className="text-sm font-medium" style={{ color: "var(--c-70)" }}>
        You must set up your free tools first
      </p>
      <a
        href="/setup"
        className="mt-3 inline-flex items-center px-4 py-2 rounded-lg text-xs font-semibold transition-opacity hover:opacity-90"
        style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}
      >
        Go to setup
      </a>
    </div>
  );
}
