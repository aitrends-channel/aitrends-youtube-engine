import { joinSegments } from "./joinSegments";
import { dedupeOverlap } from "./dedupeOverlap";

// Plans a bulk merge: which short beats get folded away, and in what order.
//
// Pure and shared so the dialog's preview and the route's execution can't
// disagree — the user approves a count, then the server derives the same plan
// from the DB and runs it. Steps use LIVE numbering (each merge renumbers
// everything after it), which is why they must be applied in order.

export interface PlanBeat {
  beatNumber: number;
  scriptSegment: string;
}

export interface MergeStep {
  /** Survivor, numbered as it will be when this step runs. */
  keep: number;
  /** Always keep + 1. */
  absorb: number;
  /** Text the survivor ends up with — the route recomputes it identically. */
  segment: string;
}

export interface MergePlan {
  steps: MergeStep[];
  /** Original beat numbers that disappear, for the preview list. */
  absorbedOriginals: number[];
  finalCount: number;
}

/** The shortest a beat is allowed to be, anywhere.
 *
 *  A beat becomes one shot and one line of narration, and "The life." is
 *  neither. The segmentation prompt asks for it and this is the number the
 *  server enforces it against afterwards, since models keep returning
 *  three-word beats for short emphatic sentences however the prompt is worded. */
export const MIN_BEAT_WORDS = 10;

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** The stubs a threshold selects, by original beat number. Direction-independent,
 *  so it drives both the Auto preview and the prompt sent to Claude. */
export function findStubs(beats: PlanBeat[], minWords: number): PlanBeat[] {
  return beats
    .slice()
    .sort((a, b) => a.beatNumber - b.beatNumber)
    .filter((b) => wordCount(b.scriptSegment ?? "") < minWords);
}

export type MergeDirection = "up" | "down";

export function planBulkMerge(
  beats: PlanBeat[],
  minWords: number,
  // A function resolves per stub (keyed by its ORIGINAL beat number) — that's
  // how "Auto" applies a different side to each one.
  direction: MergeDirection | ((stubBeatNumber: number) => MergeDirection),
): MergePlan {
  // Working copy carries the original numbers each entry now covers, so the
  // preview can name the beats that went away.
  const items = beats
    .slice()
    .sort((a, b) => a.beatNumber - b.beatNumber)
    .map((b) => ({ text: (b.scriptSegment ?? "").trim(), origins: [b.beatNumber] }));

  const steps: MergeStep[] = [];
  const absorbedOriginals: number[] = [];

  let i = 0;
  while (i < items.length) {
    const cur = items[i];
    // A blank segment is a stub too — it can't carry a shot of its own.
    if (wordCount(cur.text) >= minWords || items.length < 2) { i++; continue; }

    // Fold into the previous beat, except at the very start, where the only
    // neighbour is the one after. "down" prefers the next beat and falls back
    // to the previous on the last beat.
    const dir = typeof direction === "function" ? direction(cur.origins[0]) : direction;
    let keepIdx: number;
    if (dir === "up") keepIdx = i > 0 ? i - 1 : i;
    else keepIdx = i < items.length - 1 ? i : i - 1;

    const absorbIdx = keepIdx + 1;
    if (absorbIdx >= items.length) { i++; continue; }

    const keepItem = items[keepIdx];
    const absorbItem = items[absorbIdx];
    const merged = joinSegments(keepItem.text, dedupeOverlap(absorbItem.text, keepItem.text));

    steps.push({ keep: keepIdx + 1, absorb: absorbIdx + 1, segment: merged });
    absorbedOriginals.push(...absorbItem.origins);

    keepItem.text = merged;
    keepItem.origins.push(...absorbItem.origins);
    items.splice(absorbIdx, 1);

    // Re-test from the survivor: it may still be under the threshold when two
    // stubs sat next to each other.
    i = keepIdx;
  }

  return { steps, absorbedOriginals, finalCount: items.length };
}
