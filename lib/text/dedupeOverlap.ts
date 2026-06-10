/** Strip any leading words on `current` that duplicate the trailing
 *  words of `previous`. Used to fix script segments that Claude
 *  generated with overlapping boundaries — see the prompt rule in
 *  lib/claude/prompts.ts.
 *
 *  Walks overlap sizes K from longest (capped at 12 words) down to 1.
 *  For each K, compares the last K words of `previous` against the
 *  first K words of `current` using a punctuation/case-insensitive
 *  comparison. First match wins and the duplicated prefix is trimmed
 *  off the returned string.
 *
 *  Empirically the K=1 case fires constantly on Claude output —
 *  adjacent beats often share a single connector (`And`, `But`, `it`,
 *  `is`, ...) at the boundary because Claude chunked mid-sentence. We
 *  used to gate K=1 behind a stop-word list to avoid false positives,
 *  but real narration almost never *ends* a beat with a bare connector
 *  unless it's an artificial chunk cut — so the gate was costing us
 *  far more real fixes than it saved cohesive prose. Now any tail/head
 *  word that matches under normalization is trimmed.
 *
 *  Returns the original `current` when no overlap is found, when
 *  `previous` is null/empty, or when the entire `current` would be
 *  consumed by the trim (safety net — better to ship a repeat than
 *  silence).
 */
export function dedupeOverlap(current: string, previous: string | null | undefined): string {
  if (!previous) return current;
  const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const cur = current.trim().split(/\s+/).filter(Boolean);
  const prev = previous.trim().split(/\s+/).filter(Boolean);
  const maxK = Math.min(cur.length, prev.length, 12);
  for (let k = maxK; k >= 1; k--) {
    const prevTail = prev.slice(-k).map(norm);
    const curHead = cur.slice(0, k).map(norm);
    const allMatch = prevTail.every((w, i) => w === curHead[i] && w !== "");
    if (!allMatch) continue;
    const trimmed = cur.slice(k).join(" ");
    return trimmed || current;
  }
  return current;
}
