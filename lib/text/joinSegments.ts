// Joining two beat segments for a merge. A plain space join always reads as
// two sentences ("We hide our weaknesses. But wait."), which is wrong for the
// case merging exists to fix: a stub beat that belongs inside the line before
// it. Comma-join those instead, and lowercase the leading word when it's a
// connector or pronoun so the seam reads naturally.
//
// This is only ever a DEFAULT — the merge dialog shows the result in an
// editable field, because no rule gets every sentence right.

// Words that are safe to lowercase mid-sentence. Anything outside this list
// keeps its capital, so names and places survive ("Sarah said…" stays Sarah).
// "I" is deliberately absent — it stays capitalized.
const CONNECTORS = new Set([
  "and", "but", "so", "or", "yet", "then", "because", "which", "that",
  "if", "when", "while", "after", "before", "just", "still", "now", "though",
  "we", "you", "they", "he", "she", "it", "this", "these", "those", "there",
  "a", "an", "the", "his", "her", "their", "our", "its", "my", "your",
]);

export function joinSegments(keep: string, absorb: string): string {
  const a = keep.trim();
  const b = absorb.trim();
  if (!a) return b;
  if (!b) return a;

  // Trailing quote/bracket after the stop still counts as terminal.
  const endsWithPeriod = /\.["”'’)\]]?$/.test(a);
  const endsTerminal = /[.!?…]["”'’)\]]?$/.test(a);

  const firstWord = b.match(/^[\p{L}'’]+/u)?.[0] ?? "";
  const lower = firstWord.toLowerCase();
  // Only fold in a tail we can also de-capitalise, or "…properly, Short." and
  // "…door, Sarah was inside." come out worse than two clean sentences.
  const canLower = firstWord === lower || CONNECTORS.has(lower);

  // Never comma-join after "!" or "?" — those earn their own sentence.
  const commaJoin = !endsTerminal || (endsWithPeriod && canLower);
  if (!commaJoin) return `${a} ${b}`;

  const head = endsWithPeriod ? a.replace(/\.(["”'’)\]]?)$/, "$1") : a;
  const tail = CONNECTORS.has(lower) ? lower + b.slice(firstWord.length) : b;
  return `${head}, ${tail}`;
}
