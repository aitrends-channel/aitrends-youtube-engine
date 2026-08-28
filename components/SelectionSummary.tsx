"use client";

// What is currently set, in one line, next to the work it applies to.
//
// The picker's model card carries these controls, but the list scrolls: as soon
// as anything else is browsed the selected card slides out of view, and from
// further down the panel there is no way to check what a run is about to use
// without scrolling back. This reports the selection beside the gallery it will
// fill. Read-only on purpose — there is one place to change each setting and
// this is not it.
export function SelectionSummary({
  modelName,
  resolution,
  aspectRatio,
  durationSec,
  unitCredits,
  perClip,
}: {
  modelName: string | null;
  resolution?: string | null;
  aspectRatio?: string | null;
  durationSec?: string | number | null;
  /** Credits for one generation at these settings, priced by the server. */
  unitCredits?: number | null;
  /** Label the price per clip rather than per image. */
  perClip?: boolean;
}) {
  if (!modelName) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg px-2.5 py-1.5 text-[11px]"
      style={{ background: "var(--bg-track)", border: "1px solid var(--bd-6)" }}
    >
      <span style={{ color: "var(--c-70)" }}>{modelName}</span>
      {resolution && <span style={{ color: "var(--c-45)" }}>{resolution}</span>}
      {aspectRatio && <span style={{ color: "var(--c-45)" }}>{aspectRatio}</span>}
      {durationSec !== null && durationSec !== undefined && durationSec !== "" && (
        <span style={{ color: "var(--c-45)" }}>{durationSec}s</span>
      )}
      {unitCredits != null && (
        // Green, the colour credits are spoken about in everywhere else.
        <span className="ml-auto font-medium" style={{ color: "oklch(0.7 0.15 145)" }}>
          {unitCredits.toLocaleString(undefined, { maximumFractionDigits: 2 })} cr{perClip ? "/clip" : ""}
        </span>
      )}
    </div>
  );
}
