"use client";

import { useState, useEffect, useRef } from "react";
import { sortResolutions } from "@/lib/pricing/resolution";
import { Search } from "lucide-react";
import type { KieModel } from "@/lib/types";
import { getModelConfig } from "@/lib/kie/imageModels";
import { poyoImageConfig } from "@/lib/poyo/imageModels";
import { OPERATOR_POYO } from "@/lib/operators";
import { getVideoModelConfig } from "@/lib/kie/videoModels";
import { FREE_TIER_COMING_SOON } from "@/lib/free-tier-flag";
import { isFreeTierModel, paidModelsOnly } from "@/lib/model-tier";

// Shared model + variant selector used wherever the user picks an
// image or video model. Lives in one place so every step in the
// workflow (generate, thumbnails, any future use) renders the same
// All / Fastest / Cheapest tabs + ModelOption cards + aspect-ratio /
// resolution / duration buttons. Discriminated by `type` so the
// variant section knows whether to show resolutions (image) or
// durations (video).

type ModelTab = "all" | "fastest" | "cheapest" | "free";

interface CommonProps {
  /** Credits for one generation on the selected model at the options chosen
   *  right now. Priced by the server, since the rates and the per-resolution
   *  scaling live there and a second implementation in the browser would drift
   *  from the number the user is actually charged. */
  unitCredits?: number | null;
  models: KieModel[] | undefined;
  selectedModelId: string | null;
  /** The operator is passed alongside the id because it is no longer implied
   *  by it: KIE and PoYo both offer a model called z-image, and only the pair
   *  identifies a generation. Optional so the video picker, which has a single
   *  operator, is unaffected. */
  onSelectModel: (id: string, operator?: string) => void;
  /** Disambiguates the highlight when two operators offer the same id. */
  selectedOperator?: string | null;
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
  /** Hide the All / Fastest / Cheapest / Free category tabs and pin the
   *  list to "all". Used by the 1Click config, where category browsing
   *  is noise and the Free tab's BYO gating doesn't apply. */
  hideCategoryTabs?: boolean;
  /** Slot rendered directly under the category tabs, above the model list.
   *  The video panel puts the credit balance here: it belongs to the model
   *  choice (the free model spends it) rather than to the section header. */
  belowTabs?: React.ReactNode;
  /** Let the model list grow into the space the panel reserves instead of
   *  stopping at a fixed height. The generate step's panels have a 500px floor
   *  so the image and video columns stay row-aligned, which left dead space
   *  under the last model. Off by default: the pickers that are not in a
   *  height-constrained parent need the fixed cap, or the list would render
   *  every model with no scroll at all. */
  fillHeight?: boolean;
  /** Show `belowTabs` only while this tab is selected. The video credit
   *  balance belongs to the Free tab: it is the wallet the free models spend,
   *  and beside the paid list it reads as the balance those models draw on. */
  belowTabsOnly?: ModelTab;
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
  liveCredits,
  liveSeconds,
  atResolution,
}: {
  model: KieModel;
  selected: boolean;
  disabled?: boolean;
  onSelect: () => void;
  /** Optional content rendered inside the card, below the tags. */
  footer?: React.ReactNode;
  /** Credits for one generation on THIS model at the options currently
   *  chosen. Only the selected card gets one, because it is the only card
   *  the chosen resolution and duration apply to. */
  liveCredits?: number | null;
  /** The clip length that figure is for, so the chip can show its own
   *  arithmetic rather than appearing to triple on selection. */
  liveSeconds?: number | null;
  /** The resolution chosen for the run. Every card is priced at it, not just
   *  the selected one: the choice applies to whichever model is picked next,
   *  so quoting a floor on the others invites comparing a 480p price against a
   *  720p one. */
  atResolution?: string | null;
}) {
  // A card, not a button, because the selected one holds its own aspect ratio
  // and resolution controls and a button cannot contain buttons. The body is
  // still the button; the options sit beside it inside the same frame.
  // The price badge, wherever it is rendered.
  //
  // Two different numbers, and only one of them is the answer. The catalog
  // figure is a list price per unit, the same whatever the user picks. Once a
  // model is selected we know the resolution and the duration, so we price THAT
  // instead: an 8 cr/s clip is 48 credits at six seconds, and 8 is not what the
  // user is about to be charged.
  const price = liveCredits != null ? (
    <span
      className="px-1.5 py-0.5 rounded text-xs"
      title={model.type === "video"
        ? "What this clip costs at the chosen duration and resolution. The figure on unselected cards is a rate per second."
        : "What one image costs at the chosen resolution"}
      // Green, the colour credits are spoken about in everywhere else: the Used
      // chip on every step and the per-step figures in the sidebar. Purple is
      // the selection colour here, and a price wearing it read as another thing
      // that had been chosen.
      style={{ background: "oklch(0.55 0.15 145 / 0.14)", color: "oklch(0.7 0.15 145)" }}
    >
      {liveCredits.toLocaleString(undefined, { maximumFractionDigits: 2 })} cr
      {/* The unselected card quotes a rate per second and this one quotes the
          whole clip, so without both the same model appears to jump from 24 to
          72 on selection. Showing the rate beside the total makes it one number
          times another rather than a contradiction. */}
      {model.type === "video" && liveSeconds ? (
        <span style={{ opacity: 0.75 }}>
          {" "}for {liveSeconds}s ({(liveCredits / liveSeconds).toLocaleString(undefined, { maximumFractionDigits: 2 })}/s)
        </span>
      ) : model.type === "video" ? "/clip" : null}
    </span>
  ) : model.costPerUnit ? (() => {
    // The published figure at the chosen resolution, where the model lists
    // one. A price that varies is only "from" until a resolution is picked;
    // after that there is an exact answer and hedging is just noise.
    const byRes = model.costByResolution;
    const key = atResolution && byRes
      ? Object.keys(byRes).find((k) => k.toLowerCase() === atResolution.toLowerCase())
      : undefined;
    const perUnit = key ? byRes![key] : Number(model.costPerUnit);
    return (
    <span
      className="px-1.5 py-0.5 rounded text-xs"
      // A model with no history has no live estimate, so selecting it left the
      // floor unchanged while the duration pills moved underneath. Where the
      // published rate is per second, the same arithmetic the measured models
      // do applies here too.
      // No "from". The seed table is the price we hold and charge against
      // until the ledger has measured that model, so quoting it as a range the
      // real figure might escape described a doubt the wallet does not act on.
      title="The provider's published rate. The exact charge is settled on what the provider reports."
      style={{ background: "oklch(0.55 0.15 145 / 0.1)", color: "oklch(0.66 0.13 145)" }}
    >
      {model.type === "video" && model.costUnit !== "clip" && liveSeconds && perUnit > 0 ? (
        <>
          {(perUnit * liveSeconds).toLocaleString(undefined, { maximumFractionDigits: 2 })} cr
          <span style={{ opacity: 0.75 }}> for {liveSeconds}s ({perUnit}/s)</span>
        </>
      ) : (
        <>
          {perUnit} cr
          {model.type === "video" ? (model.costUnit === "clip" ? "/clip" : "/s") : ""}
        </>
      )}
    </span>
    );
  })() : null;

  // Which provider will really run this, when it is not the configured one.
  // Pinned to the corner rather than mixed into the tags: it is a footnote
  // about plumbing, and in the tag flow it competed with what the model is.
  const servedByTag = model.servedBy ? (
    <span
      className="absolute bottom-2 right-2 px-1.5 py-0.5 rounded text-[10px] font-semibold tracking-wide"
      title={`The configured provider does not carry this model, so it runs on ${model.servedBy.toUpperCase()}.`}
      style={{ background: "oklch(0.72 0.16 70 / 0.14)", color: "oklch(0.55 0.14 70)" }}
    >
      V{model.servedBy.charAt(0).toUpperCase()}
    </span>
  ) : null;

  const frame = {
    ...(selected ? {
      background: "oklch(0.72 0.25 285 / 0.1)",
      border: "1px solid oklch(0.72 0.25 285 / 0.3)",
      color: "var(--c-90)",
    } : {
      background: "var(--bg-input)",
      border: "1px solid var(--bd-7)",
      color: "var(--c-60)",
    }),
    opacity: disabled || model.unavailable ? 0.4 : 1,
  };

  // Selected: a labelled row per setting, so the model, what it will produce
  // and what it costs read as one list rather than a name with controls
  // hanging off it. Not a button — it holds buttons, and it is already the
  // selection, so there is nothing left to click it for.
  if (footer) {
    return (
      <div className={`relative rounded-xl transition-all p-3 space-y-1.5 ${model.servedBy ? "pb-7" : ""}`} style={frame}>
        {/* Price rides on the model row, top right. It is a property of the
            selection rather than another setting to make, and the eye finds it
            in the same place on every card. */}
        <div className="flex items-start justify-between gap-2">
          <CardRow label="Model">
            <span className="text-xs font-medium">{model.name}</span>
          </CardRow>
          {price}
        </div>
        {footer}
        {model.unavailable && (
          <p className="text-xs" style={{ color: "oklch(0.62 0.18 45)" }}>{model.unavailable}</p>
        )}
        {servedByTag}
      </div>
    );
  }

  return (
    <div className="relative rounded-xl transition-all" style={frame}>
    <button
      type="button"
      onClick={onSelect}
      // A model the active provider cannot serve is not a choice. It used to
      // be selectable and then quietly routed to the other provider, so the
      // customer picked one thing and got another.
      disabled={disabled || !!model.unavailable}
      title={model.unavailable ?? undefined}
      className={`w-full text-left p-3 rounded-xl transition-all disabled:cursor-not-allowed ${model.servedBy ? "pb-7" : ""}`}
    >
      <p className="font-medium text-xs">{model.name}</p>
      {model.unavailable && (
        <p className="text-xs mt-0.5" style={{ color: "oklch(0.62 0.18 45)" }}>{model.unavailable}</p>
      )}
      {model.description && <p className="text-xs mt-0.5 opacity-60">{model.description}</p>}
      {(model.tags?.length || price) && (
        <div className="flex gap-1 mt-2 flex-wrap">
          {model.tags?.map((tag) => (
            <span key={tag} className="px-1.5 py-0.5 rounded text-xs"
              style={{ background: "var(--bg-track)", color: "var(--c-45)" }}>
              {tag}
            </span>
          ))}

          {price}
        </div>
      )}
    </button>
    {servedByTag}
    </div>
  );
}

/** One `Label   value` line inside a selected model card. The label is fixed
 *  width so every row's values start at the same place. */
function CardRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-wider shrink-0 w-[74px]" style={{ color: "var(--c-40)" }}>
        {label}
      </span>
      <div className="flex flex-wrap items-center gap-1 min-w-0">{children}</div>
    </div>
  );
}

function VariantPill<T>({
  label,
  selected,
  disabled,
  onClick,
  compact,
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  /** Tighter padding and type. Used for aspect ratios, where five or six
   *  three-character labels have to fit one row of the card's right column
   *  and wrapping them reads as two settings rather than one. */
  compact?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`rounded-md font-medium transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
        compact ? "px-1.5 py-0.5 text-[11px] leading-tight" : "px-2.5 py-1 rounded-lg text-xs"
      }`}
      style={selected ? {
        background: "oklch(0.72 0.25 285 / 0.15)",
        border: "1px solid oklch(0.72 0.25 285 / 0.4)",
        color: "var(--accent-purple-text)",
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
  const openedOnFree = useRef(false);
  const [query, setQuery] = useState("");

  const searchQ = query.trim().toLowerCase();
  const matchesSearch = (m: KieModel) =>
    !searchQ ||
    m.name.toLowerCase().includes(searchQ) ||
    m.id.toLowerCase().includes(searchQ) ||
    (m.tags ?? []).some((t) => t.toLowerCase().includes(searchQ));

  // Sort the model list according to the active tab. Fastest/Cheapest
  // are ledger-driven and hide models without observed data so the tab
  // only shows ranked entries. "all" preserves the upstream order.
  // Free-tier models are marked by tag rather than by id, so the picker needs
  // no knowledge of which provider is behind them and a second free model
  // later needs no change here. Video has one (GenAIPro, on Heclus's own
  // account); image and voiceover have none yet, which is why the Free tab
  // still shows its teaser for those.
  const freeModels = (models ?? []).filter(isFreeTierModel);
  const hasFree = freeModels.length > 0;

  // A free model is only listed under the Free tab, so a user coming back to a
  // saved free selection would open on All and see nothing selected. Land them
  // on the tab that holds their choice — once, so it never fights a click.
  useEffect(() => {
    if (openedOnFree.current || !selectedModelId || !hasFree) return;
    if (freeModels.some((m) => m.id === selectedModelId)) {
      openedOnFree.current = true;
      setTab("free");
    }
  }, [selectedModelId, hasFree, freeModels]);

  const list: KieModel[] | null = (() => {
    if (!models) return null;
    const base = models.slice();
    if (tab === "free") return freeModels.filter(matchesSearch);
    // Every other tab excludes them: the Free tab is their home, and listing
    // them twice makes the free option look like just another paid model.
    const paid = paidModelsOnly(base);
    if (tab === "fastest") {
      return paid
        .filter((m) => typeof m.avgSpeedMs === "number" && m.avgSpeedMs > 0 && matchesSearch(m))
        .sort((a, b) => (a.avgSpeedMs ?? Infinity) - (b.avgSpeedMs ?? Infinity));
    }
    if (tab === "cheapest") {
      return paid
        .filter((m) => m.costPerUnit !== undefined && m.costPerUnit !== null && matchesSearch(m))
        .sort((a, b) => Number(a.costPerUnit) - Number(b.costPerUnit));
    }
    return paid.filter(matchesSearch);
  })();

  const empty = models && (
    tab === "free"
      ? !hasFree
      : tab === "fastest"
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
  // Provider-aware, because the id alone does not say whose model it is and
  // the two disagree on both lists: PoYo's gpt-4o-image has no 16:9 at all,
  // and only some PoYo models take a resolution. Read from the selected
  // model's own operator when the caller did not pass one, so the thumbnail
  // and 1Click pickers get it right without threading a prop through.
  const selectedOperator = props.selectedOperator
    ?? (models?.find((m) => m.id === selectedModelId) as { operator?: string } | undefined)?.operator;
  const imageConfig = type === "image" && selectedModelId
    ? (selectedOperator === OPERATOR_POYO ? poyoImageConfig(selectedModelId) : getModelConfig(selectedModelId))
    : null;
  // Operator-aware for the same reason the image branch above is: PoYo accepts
  // different resolution sets for the same model ids, so KIE's list under PoYo
  // offers choices PoYo rejects and hides ones it accepts.
  const videoConfig = type === "video" && selectedModelId
    ? getVideoModelConfig(selectedModelId, selectedOperator)
    : null;
  const config = imageConfig ?? videoConfig;

  const tipText = props.tip
    ?? (type === "image"
      ? "Tip: if a model keeps failing, pick another above and re-run — successful images stay."
      : "Tip: if a model keeps failing, pick another above and re-queue — existing clips stay.");

  // The options live on the model they belong to.
  //
  // They used to sit under the whole list, which read as settings for the
  // section rather than for the thing selected, and put the resolution that
  // changes the price a scroll away from the price. Built here, where the
  // configs are, and rendered inside the selected card.
  const variantControls = !selectedModelId ? null : (
    <>
      {props.type === "image" && imageConfig?.resolutions && imageConfig.resolutions.length > 0 && (
        <CardRow label="Resolution">
          {sortResolutions("image", imageConfig.resolutions).map((res) => (
            <VariantPill
              key={res}
              label={res}
              compact
              selected={props.selectedResolution === res}
              disabled={disabled}
              onClick={() => props.onSelectResolution(res === props.selectedResolution ? null : res)}
            />
          ))}
        </CardRow>
      )}

      {/* The provider's field name for the video resolution knob varies (kling
          uses "mode", runway "quality", most "resolution") but the picker
          treats them uniformly; submit code reads resolutionKey off the
          config to send under the right one. */}
      {props.type === "video" && videoConfig?.resolutions && videoConfig.resolutions.length > 0 && (
        <CardRow label="Resolution">
          {sortResolutions("video", videoConfig.resolutions).map((res) => (
            <VariantPill
              key={res}
              label={res}
              compact
              selected={props.selectedResolution === res}
              disabled={disabled}
              // Set-only, not toggle. Video models expect exactly one
              // resolution: clicking the selected pill used to unset it and
              // fall back to the provider default, which surfaced as "I picked
              // 4K but got 720p".
              onClick={() => props.onSelectResolution(res)}
            />
          ))}
        </CardRow>
      )}

      {/* Aspect ratio. Locked on the video panel, where the clip inherits the
          source image's ratio and there is nothing to choose. */}
      {props.hideAspectRatio ? null : props.lockAspectRatio ? (
        <CardRow label="Aspect ratio">
          <span className="text-xs" style={{ color: "var(--c-55)" }}>
            {props.selectedAspectRatio || "not set"}, matching the image
          </span>
        </CardRow>
      ) : config && config.aspectRatios.length > 0 ? (
        <CardRow label="Aspect ratio">
          {config.aspectRatios.map((r) => (
            <VariantPill
              key={r}
              label={r}
              compact
              selected={props.selectedAspectRatio === r}
              disabled={disabled}
              onClick={() => props.onSelectAspectRatio(r)}
            />
          ))}
        </CardRow>
      ) : null}

      {props.type === "video" && videoConfig && videoConfig.durations.length > 0 && (
        <CardRow label="Duration">
          {videoConfig.durations.map((d) => (
            <VariantPill
              key={String(d.value)}
              label={d.label}
              compact
              selected={props.selectedDuration === d.value}
              disabled={disabled}
              onClick={() => props.onSelectDuration(d.value)}
            />
          ))}
        </CardRow>
      )}
    </>
  );

  return (
    <div className={props.fillHeight ? "flex flex-col h-full min-h-0" : undefined}>
      <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>
        Select Model
      </p>

      {!props.hideCategoryTabs && (
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
              color: "var(--accent-purple-text)",
              boxShadow: "inset 0 0 0 1px oklch(0.72 0.25 285 / 0.35)",
            } : { background: "transparent", color: "var(--c-55)" }}
          >
            {t === "free" && FREE_TIER_COMING_SOON && !hasFree ? (
              <span className="flex flex-col items-center leading-tight">
                <span>😄 Free</span>
                <span className="text-[9px] font-semibold normal-case">coming soon</span>
              </span>
            ) : t}
          </button>
        ))}
      </div>
      )}

      {props.belowTabs && (!props.belowTabsOnly || tab === props.belowTabsOnly) && (
        <div className="mb-2">{props.belowTabs}</div>
      )}

      {tab === "free" && !hasFree && !props.hideCategoryTabs ? (
        // Free tier is a teaser for now — the BYO implementations behind
        // it were removed.
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
      ) : (
      <div className={props.fillHeight ? "flex flex-col flex-1 min-h-0" : "contents"}>
      {/* The Free tab holds a handful of models at most, so a search field
          there is furniture rather than help. */}
      {tab !== "free" && (
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
      )}

      {/* Above the list, not below it: it is guidance for choosing, so it has
          to be read before the options rather than after scrolling past them.
          Not on the Free tab: it tells the reader to pick another model, and
          there is nothing else there to pick. */}
      {tipText && tab !== "free" && (
        <p className="text-[11px] mb-2 leading-snug" style={{ color: "var(--c-40)" }}>
          {tipText}
        </p>
      )}

      <div className={`space-y-2 overflow-y-auto pr-1 ${props.fillHeight ? "flex-1 min-h-[8rem]" : "max-h-52"}`}>
        {list?.map((m) => {
          // Keyed and matched on operator + id, not id alone: the merged
          // catalog can carry the same model from two providers, which would
          // otherwise collide React keys and highlight both rows at once.
          const op = (m as { operator?: string }).operator;
          return (
            <ModelOption
              key={`${op ?? "kie"}:${m.id}`}
              model={m}
              selected={selectedModelId === m.id && (!op || !props.selectedOperator || op === props.selectedOperator)}
              disabled={disabled}
              onSelect={() => onSelectModel(m.id, op)}
              liveCredits={
                selectedModelId === m.id && (!op || !props.selectedOperator || op === props.selectedOperator)
                  ? props.unitCredits
                  : null
              }
              liveSeconds={props.type === "video" ? Number(props.selectedDuration) || null : null}
              atResolution={props.selectedResolution}
              footer={
                selectedModelId === m.id && (!op || !props.selectedOperator || op === props.selectedOperator)
                  ? variantControls
                  : null
              }
            />
          );
        })}
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

      {/* Aspect ratio, resolution and duration used to live here, under the
          whole list. They now render inside the selected model's card, where
          the thing they configure is. */}

      </div>
      )}

    </div>
  );
}
