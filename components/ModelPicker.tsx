"use client";

import { useState } from "react";
import type { KieModel } from "@/lib/types";
import { getModelConfig } from "@/lib/kie/imageModels";
import { getVideoModelConfig } from "@/lib/kie/videoModels";

// Shared model + variant selector used wherever the user picks an
// image or video model. Lives in one place so every step in the
// workflow (generate, thumbnails, any future use) renders the same
// All / Fastest / Cheapest tabs + ModelOption cards + aspect-ratio /
// resolution / duration buttons. Discriminated by `type` so the
// variant section knows whether to show resolutions (image) or
// durations (video).

type ModelTab = "all" | "fastest" | "cheapest";

interface CommonProps {
  models: KieModel[] | undefined;
  selectedModelId: string | null;
  onSelectModel: (id: string) => void;
  selectedAspectRatio: string;
  onSelectAspectRatio: (r: string) => void;
  disabled?: boolean;
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
}

export type ModelPickerProps = ImageModelPickerProps | VideoModelPickerProps;

function ModelOption({
  model,
  selected,
  disabled,
  onSelect,
}: {
  model: KieModel;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
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

  // Sort the model list according to the active tab. Fastest/Cheapest
  // are ledger-driven and hide models without observed data so the tab
  // only shows ranked entries. "all" preserves the upstream order.
  const list: KieModel[] | null = (() => {
    if (!models) return null;
    const base = models.slice();
    if (tab === "fastest") {
      return base
        .filter((m) => typeof m.avgSpeedMs === "number" && m.avgSpeedMs > 0)
        .sort((a, b) => (a.avgSpeedMs ?? Infinity) - (b.avgSpeedMs ?? Infinity));
    }
    if (tab === "cheapest") {
      return base
        .filter((m) => m.costPerUnit !== undefined && m.costPerUnit !== null)
        .sort((a, b) => Number(a.costPerUnit) - Number(b.costPerUnit));
    }
    return base;
  })();

  const empty = models && (
    tab === "fastest"
      ? !models.some((m) => typeof m.avgSpeedMs === "number" && m.avgSpeedMs > 0)
      : tab === "cheapest"
        ? !models.some((m) => m.costPerUnit !== undefined && m.costPerUnit !== null)
        : models.length === 0
  );

  const config = selectedModelId
    ? type === "image"
      ? getModelConfig(selectedModelId)
      : getVideoModelConfig(selectedModelId)
    : null;

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
        {(["all", "fastest", "cheapest"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            disabled={disabled}
            className="flex-1 px-2 py-1 rounded-md text-xs font-medium capitalize transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            style={tab === t ? {
              background: "oklch(0.72 0.25 285 / 0.15)",
              color: "oklch(0.88 0.12 285)",
              boxShadow: "inset 0 0 0 1px oklch(0.72 0.25 285 / 0.35)",
            } : { background: "transparent", color: "var(--c-55)" }}
          >
            {t}
          </button>
        ))}
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

      {config && config.aspectRatios.length > 0 && (
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

      {props.type === "image" && config && "resolutions" in config && config.resolutions && config.resolutions.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-wider mt-3 mb-2" style={{ color: "var(--c-40)" }}>
            Resolution
          </p>
          <div className="flex flex-wrap gap-1.5">
            {config.resolutions.map((res) => (
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

      {props.type === "video" && config && "durations" in config && config.durations.length > 0 && (
        <>
          <p className="text-xs font-semibold uppercase tracking-wider mt-3 mb-2" style={{ color: "var(--c-40)" }}>
            Duration
          </p>
          <div className="flex gap-1">
            {config.durations.map((d) => (
              <VariantPill
                key={String(d.value)}
                label={d.label}
                selected={props.selectedDuration === d.value}
                disabled={disabled}
                onClick={() => props.onSelectDuration(d.value)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
