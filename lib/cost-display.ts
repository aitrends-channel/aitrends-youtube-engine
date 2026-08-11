// Display helpers for the cost ledger's raw provider units. Shared by the
// per-project cost view and the dashboard usage section (the admin Cost table
// still carries its own copies alongside its admin-only unitLabel).

// Compact number for tight cells:
//   1500     → "1.5k"
//   42000    → "42k"
//   1500000  → "1.5M"
// Fractional KIE credits (e.g. 9.6) render with one decimal up to 999.x; over
// a thousand they go to k-units like everything else.
export function compactNumber(n: number): string {
  if (n === 0) return "0";
  if (n < 10 && !Number.isInteger(n)) return n.toFixed(1).replace(/\.0$/, "");
  if (n < 1000) return Math.round(n).toString();
  if (n < 1_000_000) {
    const k = n / 1000;
    return k >= 100 ? `${Math.round(k)}k` : `${k.toFixed(1).replace(/\.0$/, "")}k`;
  }
  const m = n / 1_000_000;
  return m >= 100 ? `${Math.round(m)}M` : `${m.toFixed(1).replace(/\.0$/, "")}M`;
}

// Short suffix for each unit kind logged by the cost ledger. Picked to be
// unambiguous at a glance inside a tight cell — "60 cr" reads as KIE credits,
// "12k tok" as Claude tokens. Falls back to the raw kind for unknown units so
// future additions show up as labeled strings rather than silently
// disappearing.
//
// "claude_tokens" is the collapsed bucket callers build by merging the four
// claude_tokens_* sub-kinds; the sub-kinds stay listed as a fallback.
export function unitSuffix(unitKind: string): string {
  switch (unitKind) {
    case "claude_tokens":
    case "claude_tokens_in":
    case "claude_tokens_out":
    case "claude_tokens_cache_read":
    case "claude_tokens_cache_creation":
      return "tok";
    case "kie_credits":          return "cr";
    case "elevenlabs_chars":     return "chr";
    case "supadata_transcripts": return "tx";
    default:                     return unitKind;
  }
}
