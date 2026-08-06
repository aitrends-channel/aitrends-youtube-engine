"use client";

import { useState } from "react";
import { VoiceOption } from "@/components/VoiceOption";
import type { KieModel } from "@/lib/types";

type Tier = "paid" | "free";
type Gender = "female" | "male";

// Gender comes from the voice's tags ("Female"/"Male"). Voices without a
// gender tag appear under both tabs so nothing becomes unreachable.
function matchesGender(m: KieModel, gender: Gender) {
  const tags = (m.tags ?? []).map((t) => t.toLowerCase());
  const tagged = tags.includes("female") || tags.includes("male");
  return !tagged || tags.includes(gender);
}

// The voiceover step's voice picker as a reusable unit: search box +
// scrollable two-column grid of VoiceOption cards with audio preview,
// plus the same loading treatment.
//
// Two levels of tabs when `freeVoices` is supplied: Paid / Free on top,
// Female / Male beneath. The gender selection is shared across tiers, so
// switching Paid<->Free keeps you on the same gender. Omit `freeVoices`
// and the tier row is hidden, leaving the plain Female/Male picker.
export function VoicePickerGrid({
  voices,
  freeVoices,
  selectedId,
  onSelect,
  playingId,
  onPlayToggle,
  searchLabel = "voices",
}: {
  voices: KieModel[] | undefined;
  /** Free-tier voices, shown under their own top-level tab. */
  freeVoices?: KieModel[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  playingId: string | null;
  onPlayToggle: (id: string | null) => void;
  searchLabel?: string;
}) {
  const [search, setSearch] = useState("");
  const [tier, setTier] = useState<Tier>("paid");
  const [gender, setGender] = useState<Gender>("female");
  const q = search.trim().toLowerCase();

  const hasFree = Boolean(freeVoices?.length);
  const activeTier: Tier = hasFree ? tier : "paid";

  const source = activeTier === "free" ? (freeVoices ?? []) : (voices ?? []);
  const filtered = source.filter(
    (m) => matchesGender(m, gender)
      && (!q || m.name.toLowerCase().includes(q) || (m.tags ?? []).some((t) => t.toLowerCase().includes(q))),
  );

  // Only the paid catalog is fetched; freeVoices is a static list, so the
  // Free tab never needs the spinner.
  const loading = activeTier === "paid" && !voices;

  // Two distinct treatments so the hierarchy is obvious at a glance:
  // the tier is a solid filled segment (the app's primary tab look), the
  // gender beneath it a lighter tinted pill.
  const tierPill = (active: boolean) => active
    ? { background: "oklch(0.72 0.25 285)", color: "white", boxShadow: "0 2px 8px oklch(0.72 0.25 285 / 0.35)" }
    : { background: "transparent", color: "var(--c-55)" };

  const genderPill = (active: boolean) => active
    ? {
        background: "oklch(0.72 0.25 285 / 0.15)",
        color: "var(--accent-purple-text)",
        boxShadow: "inset 0 0 0 1px oklch(0.72 0.25 285 / 0.35)",
      }
    : { background: "transparent", color: "var(--c-55)" };

  return (
    <div>
      {/* Tier — Paid / Free. Primary level: bigger, bordered container,
          solid filled active segment. */}
      {hasFree && (
        <div className="flex items-center gap-1 mb-2.5 p-1 rounded-xl"
          style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-card)" }}>
          {([["paid", "Paid"], ["free", "Free"]] as [Tier, string][]).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => { setTier(id); setSearch(""); }}
              aria-pressed={tier === id}
              className="flex-1 flex items-center justify-center px-3 py-2 rounded-lg text-sm font-semibold transition-all cursor-pointer"
              style={tierPill(tier === id)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* Gender — shared across both tiers. Secondary level: smaller,
          borderless track, tinted active pill. */}
      <div className="flex gap-1 mb-3 p-0.5 rounded-lg" style={{ background: "var(--bg-track)" }}>
        {([["female", "Female"], ["male", "Male"]] as [Gender, string][]).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setGender(id)}
            aria-pressed={gender === id}
            className="flex-1 flex items-center justify-center px-2 py-1 rounded-md text-xs font-medium transition-all cursor-pointer"
            style={genderPill(gender === id)}
          >
            {label}
          </button>
        ))}
      </div>

      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={`Search ${activeTier === "free" ? "free voices" : searchLabel}…`}
        aria-label="Search voices"
        className="w-full px-2.5 py-1.5 rounded-lg text-xs outline-none transition-colors mb-3"
        style={{
          background: "var(--bg-input)",
          border: "1px solid oklch(0.72 0.25 285 / 0.3)",
          color: "var(--c-70)",
        }}
      />
      {q && filtered.length === 0 && (
        <p className="text-xs text-center py-4" style={{ color: "var(--c-40)" }}>
          No voices match &ldquo;{search.trim()}&rdquo;
        </p>
      )}
      <div className="scroll-themed grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-60 overflow-y-auto pr-1">
        {loading ? (
          <div className="col-span-full flex flex-col items-center justify-center py-10 gap-2">
            <span className="block w-6 h-6 border-2 rounded-full animate-spin"
              style={{ borderColor: "oklch(0.72 0.25 285 / 0.3)", borderTopColor: "oklch(0.72 0.25 285)" }} />
            <p className="text-xs" style={{ color: "var(--c-40)" }}>Loading…</p>
          </div>
        ) : (
          <>
            {filtered.length === 0 && !q && (
              <p className="text-xs px-1" style={{ color: "var(--c-40)" }}>
                No {gender} voices available
              </p>
            )}
            {filtered.map((m) => (
              <VoiceOption
                key={m.id}
                model={m}
                selected={selectedId === m.id}
                onSelect={() => onSelect(m.id)}
                isPlaying={playingId === m.id}
                onPlayToggle={onPlayToggle}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
