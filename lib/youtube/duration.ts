// Video-duration helpers shared by the channel step and the 1Click
// kickoff. Both need the same long-channel threshold: Heclus's downstream
// pipeline (transcripts + analysis prompt size + KIE proxy) handles short
// videos well but degrades on 45min+, so that case is surfaced as an
// explicit user confirmation rather than silently truncating later.

export const MAX_AVG_DURATION_SECONDS = 45 * 60;

/** ISO-8601 duration ("PT12M34S") to seconds. Null when absent/unparseable. */
export function parseDurationSeconds(iso?: string): number | null {
  if (!iso) return null;
  const m = iso.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!m) return null;
  const h = parseInt(m[1] ?? "0", 10);
  const min = parseInt(m[2] ?? "0", 10);
  const s = parseInt(m[3] ?? "0", 10);
  return h * 3600 + min * 60 + s;
}

/** Mean duration across the videos that have a parseable duration. */
export function averageDurationSeconds(videos: { duration?: string }[]): number | null {
  const seconds = videos.map((v) => parseDurationSeconds(v.duration)).filter((s): s is number => s != null);
  if (!seconds.length) return null;
  return Math.round(seconds.reduce((sum, s) => sum + s, 0) / seconds.length);
}

/** True when the channel's average runtime is past the point where the
 *  pipeline needs the user's say-so before continuing. */
export function needsLongVideoConsent(avgSeconds: number | null): boolean {
  return avgSeconds != null && avgSeconds > MAX_AVG_DURATION_SECONDS;
}

export function formatSecondsAsHHMMSS(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const min = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(h)}:${pad(min)}:${pad(s)}`;
}
