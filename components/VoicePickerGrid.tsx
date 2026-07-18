"use client";

import { useState } from "react";
import { VoiceOption } from "@/components/VoiceOption";
import type { KieModel } from "@/lib/types";

// The voiceover step's voice picker as a reusable unit: search box +
// scrollable two-column grid of VoiceOption cards with audio preview,
// plus the same loading treatment. Used by the 1Click config so voice
// selection looks and behaves exactly like the wizard's.
export function VoicePickerGrid({ voices, selectedId, onSelect, playingId, onPlayToggle, searchLabel = "voices" }: {
  voices: KieModel[] | undefined;
  selectedId: string | null;
  onSelect: (id: string) => void;
  playingId: string | null;
  onPlayToggle: (id: string | null) => void;
  searchLabel?: string;
}) {
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const filtered = (voices ?? []).filter(
    (m) => !q || m.name.toLowerCase().includes(q) || (m.tags ?? []).some((t) => t.toLowerCase().includes(q)),
  );

  return (
    <div>
      <input
        type="search"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={`Search ${searchLabel}…`}
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
        {!voices ? (
          <div className="col-span-full flex flex-col items-center justify-center py-10 gap-2">
            <span className="block w-6 h-6 border-2 rounded-full animate-spin"
              style={{ borderColor: "oklch(0.72 0.25 285 / 0.3)", borderTopColor: "oklch(0.72 0.25 285)" }} />
            <p className="text-xs" style={{ color: "var(--c-40)" }}>Loading…</p>
          </div>
        ) : (
          <>
            {filtered.length === 0 && !q && (
              <p className="text-xs px-1" style={{ color: "var(--c-40)" }}>No voices available</p>
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
