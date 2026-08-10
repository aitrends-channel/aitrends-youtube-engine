"use client";

import { useState } from "react";
import useSWR from "swr";
import { compactNumber } from "@/lib/cost-display";
import type { MeUsageStats } from "@/app/api/me/usage-stats/route";

// Consumption the account has actually spent, from the project_costs ledger.
// Lives under the API key cards so the "API keys & usage" tab answers both
// halves of its name: what is connected, and what it has burned.
//
// Raw provider units, no USD. Credits, characters and tokens are three
// different scales, so they never share an axis: the bars encode KIE credits
// (the currency almost every step spends) and the other two appear as values.

const fetcher = (url: string) => fetch(url).then((r) => r.json());

const STEP_LABEL: Record<string, string> = {
  channel_analysis: "Channel",
  topic:            "Topic",
  script:           "Script",
  visuals:          "Visuals",
  prompts:          "Prompts",
  voiceover:        "Voiceover",
  generate:         "Generate",
  assemble:         "Assemble",
  thumbnail:        "Thumbnail",
};

const PURPLE = "#9b7ff5";

const cardStyle = { background: "oklch(1 0 0 / 0.08)", border: "1px solid var(--bd-card)" };

function Tile({ value, unit, label, hint }: { value: string; unit?: string; label: string; hint?: string }) {
  return (
    <div className="rounded-xl px-4 sm:px-5 py-4 min-h-[92px]" style={cardStyle}>
      <p className="leading-none">
        <span className="text-2xl font-bold tabular-nums" style={{ color: "var(--c-90)" }}>{value}</span>
        {unit && <span className="text-xs ml-1.5" style={{ color: "var(--c-50)" }}>{unit}</span>}
      </p>
      <p className="text-xs mt-2" style={{ color: "var(--c-42)" }}>{label}</p>
      {hint && <p className="text-[10px] mt-1" style={{ color: "var(--c-35)" }}>{hint}</p>}
    </div>
  );
}

// 30 daily bars. Labels only every 7th day: one per bar collides at this width.
function DailyChart({ daily }: { daily: MeUsageStats["daily"] }) {
  const [hovered, setHovered] = useState<number | null>(null);

  const W = 600, H = 150, PAD_X = 16, PAD_T = 16, PAD_B = 24;
  const plotH = H - PAD_T - PAD_B;
  const plotW = W - PAD_X * 2;
  const slotW = plotW / daily.length;
  const barW = Math.min(slotW - 6, 14);
  const rx = 2.5;
  const max = Math.max(...daily.map((d) => d.kieCredits), 1);

  const dayLabel = (iso: string) =>
    new Date(`${iso}T00:00:00Z`).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" });

  return (
    <div style={{ overflowX: "clip" }}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseLeave={() => setHovered(null)}>
        <defs>
          <linearGradient id="usageBarG" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={PURPLE} stopOpacity="0.95" />
            <stop offset="100%" stopColor={PURPLE} stopOpacity="0.45" />
          </linearGradient>
          <linearGradient id="usageBarH" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#b89dff" stopOpacity="1" />
            <stop offset="100%" stopColor={PURPLE} stopOpacity="0.7" />
          </linearGradient>
        </defs>

        {[0.33, 0.67, 1].map((f) => (
          <line key={f} x1={PAD_X} y1={PAD_T + plotH - f * plotH} x2={W - PAD_X} y2={PAD_T + plotH - f * plotH}
            style={{ stroke: "oklch(1 0 0 / 0.05)" }} strokeWidth="1" />
        ))}
        <line x1={PAD_X} y1={PAD_T + plotH} x2={W - PAD_X} y2={PAD_T + plotH}
          style={{ stroke: "oklch(1 0 0 / 0.08)" }} strokeWidth="1" />

        {daily.map((d, i) => {
          const cx = PAD_X + slotW * i + slotW / 2;
          const bx = cx - barW / 2;
          // Floor a non-zero day at 2 units tall so a small day still reads as
          // activity rather than as nothing.
          const barH = d.kieCredits > 0 ? Math.max((d.kieCredits / max) * plotH, 2) : 0;
          const by = PAD_T + plotH - barH;
          const hov = hovered === i;
          return (
            <g key={d.date} onMouseEnter={() => setHovered(i)}>
              {/* Full-height hit target: the bars themselves are too thin to hover. */}
              <rect x={cx - slotW / 2} y={PAD_T} width={slotW} height={plotH} fill="transparent" />
              {barH > 0 ? (
                <path d={`M ${bx + rx} ${by} H ${bx + barW - rx} Q ${bx + barW} ${by} ${bx + barW} ${by + rx} V ${PAD_T + plotH} H ${bx} V ${by + rx} Q ${bx} ${by} ${bx + rx} ${by}`}
                  fill={hov ? "url(#usageBarH)" : "url(#usageBarG)"} />
              ) : (
                <rect x={bx} y={PAD_T + plotH - 1.5} width={barW} height={1.5} rx={0.75}
                  style={{ fill: hov ? "oklch(1 0 0 / 0.22)" : "oklch(1 0 0 / 0.1)" }} />
              )}
              {i % 7 === 0 && (
                <text x={cx} y={PAD_T + plotH + 15} textAnchor="middle" fontSize="9"
                  style={{ fill: "var(--c-35)" }}>{dayLabel(d.date)}</text>
              )}
            </g>
          );
        })}

        {hovered !== null && (() => {
          const d = daily[hovered];
          const cx = PAD_X + slotW * hovered + slotW / 2;
          const barH = d.kieCredits > 0 ? Math.max((d.kieCredits / max) * plotH, 2) : 0;
          const TW = 94, TH = 30;
          const TX = Math.min(Math.max(cx - TW / 2, PAD_X), W - PAD_X - TW);
          const TY = Math.max(PAD_T + plotH - barH - TH - 6, 2);
          return (
            <g style={{ pointerEvents: "none" }}>
              <rect x={TX} y={TY} width={TW} height={TH} rx={5} ry={5}
                style={{ fill: "oklch(0.12 0.02 285)" }} stroke={PURPLE} strokeOpacity="0.4" strokeWidth="1" />
              <text x={TX + TW / 2} y={TY + 12} textAnchor="middle" fontSize="9.5" fontWeight="500"
                style={{ fill: "oklch(0.88 0 0)" }}>{dayLabel(d.date)}</text>
              <text x={TX + TW / 2} y={TY + 24} textAnchor="middle" fontSize="10" fontWeight="700" fill={PURPLE}>
                {compactNumber(d.kieCredits)} credits
              </text>
            </g>
          );
        })()}
      </svg>
    </div>
  );
}

function Skeleton() {
  return (
    <div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-xl px-5 py-4 min-h-[92px] animate-pulse" style={cardStyle} />
        ))}
      </div>
      <div className="rounded-2xl mt-4 animate-pulse" style={{ ...cardStyle, height: 180 }} />
    </div>
  );
}

export function UsageStats() {
  const { data, error, isLoading } = useSWR<MeUsageStats>("/api/me/usage-stats", fetcher, { revalidateOnFocus: false });
  const [range, setRange] = useState<"d30" | "all">("d30");

  if (isLoading) {
    return (
      <div style={{ marginTop: "40px" }}>
        <h3 className="text-sm font-semibold" style={{ color: "var(--c-60)", marginBottom: "14px" }}>Your Usage</h3>
        <Skeleton />
      </div>
    );
  }

  // A failed read is not the same as no usage. Say so rather than reporting zeros.
  if (error || !data || "error" in data) {
    return (
      <div style={{ marginTop: "40px" }}>
        <h3 className="text-sm font-semibold" style={{ color: "var(--c-60)", marginBottom: "14px" }}>Your Usage</h3>
        <div className="rounded-2xl px-6 py-8 text-center" style={cardStyle}>
          <p className="text-sm font-medium" style={{ color: "var(--c-45)" }}>Usage could not be loaded</p>
          <p className="text-xs mt-1" style={{ color: "var(--c-30)" }}>Refresh the page to try again</p>
        </div>
      </div>
    );
  }

  const w = data[range];
  const hasAnyUsage = data.all.kieCredits > 0 || data.all.elevenlabsChars > 0 || data.all.claudeTokens > 0;
  const maxStepCredits = Math.max(...w.steps.map((s) => s.kieCredits), 0);
  const sinceLabel = data.since
    ? new Date(data.since).toLocaleDateString("en", { month: "short", year: "numeric" })
    : null;

  return (
    <div style={{ marginTop: "40px" }}>
      <div className="flex items-center justify-between gap-3 flex-wrap" style={{ marginBottom: "14px" }}>
        <h3 className="text-sm font-semibold" style={{ color: "var(--c-60)" }}>Your Usage</h3>
        <div className="rounded-xl p-1 flex gap-1 self-start w-fit"
          style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-card)" }}>
          {([["d30", "30 days"], ["all", "All time"]] as const).map(([id, label]) => (
            <button key={id} onClick={() => setRange(id)}
              className="px-3 py-1 rounded-lg text-xs font-medium transition-all cursor-pointer"
              style={range === id
                ? { background: "oklch(0.72 0.25 285 / 0.15)", border: "1px solid oklch(0.72 0.25 285 / 0.4)", color: "oklch(0.88 0.12 285)" }
                : { background: "transparent", border: "1px solid transparent", color: "var(--c-55)" }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      {!hasAnyUsage ? (
        <div className="rounded-2xl px-6 py-10 flex flex-col items-center justify-center text-center" style={cardStyle}>
          <p className="text-sm font-medium" style={{ color: "var(--c-45)" }}>No usage yet</p>
          <p className="text-xs mt-1" style={{ color: "var(--c-30)" }}>Credits, characters and tokens show up here as soon as you generate your first video</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Tile
              value={compactNumber(w.kieCredits)}
              unit="credits"
              label="KIE spent"
              hint="Images, video and voiceover"
            />
            <Tile
              value={compactNumber(w.elevenlabsChars)}
              unit="chars"
              label="ElevenLabs voiceover"
              hint="Speech and transcription"
            />
            <Tile
              value={compactNumber(w.claudeTokens)}
              unit="tokens"
              label="Claude writing steps"
              hint={w.claudeTokens > 0 ? "On your own Anthropic key" : "Routed through KIE credits"}
            />
            <Tile
              value={w.videos.toString()}
              unit={w.videos === 1 ? "video" : "videos"}
              label="Videos with activity"
              hint={`${w.generated} reached generation`}
            />
          </div>

          {/* Always the last 30 days: the ledger is only summarised per day for
              that window, and the range toggle above governs the totals. */}
          <div className="rounded-2xl px-4 py-4 sm:px-6 sm:py-5 mt-4" style={cardStyle}>
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <p className="text-sm font-semibold" style={{ color: "var(--c-75)" }}>Credits per day</p>
                <p className="text-xs mt-0.5" style={{ color: "var(--c-35)" }}>Last 30 days</p>
              </div>
              <span className="text-2xl font-bold tabular-nums" style={{ color: "var(--c-90)" }}>
                {compactNumber(data.d30.kieCredits)}
              </span>
            </div>
            {data.daily.some((d) => d.kieCredits > 0)
              ? <DailyChart daily={data.daily} />
              : <p className="text-xs py-6 text-center" style={{ color: "var(--c-30)" }}>No credits spent in the last 30 days</p>}
          </div>

          <div className="rounded-2xl px-4 py-4 sm:px-6 sm:py-5 mt-4" style={cardStyle}>
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <p className="text-sm font-semibold" style={{ color: "var(--c-75)" }}>Where it went</p>
                <p className="text-xs mt-0.5" style={{ color: "var(--c-35)" }}>
                  Bars show KIE credits per step{range === "all" && sinceLabel ? `, since ${sinceLabel}` : ""}
                </p>
              </div>
            </div>

            {w.steps.length === 0 ? (
              <p className="text-xs py-2" style={{ color: "var(--c-30)" }}>Nothing spent in this range</p>
            ) : (
              <div className="space-y-3">
                {w.steps.map((s) => {
                  const pct = maxStepCredits > 0 ? (s.kieCredits / maxStepCredits) * 100 : 0;
                  const extras = [
                    s.elevenlabsChars > 0 ? `${compactNumber(s.elevenlabsChars)} chr` : null,
                    s.claudeTokens > 0 ? `${compactNumber(s.claudeTokens)} tok` : null,
                  ].filter(Boolean);
                  return (
                    <div key={s.step}>
                      <div className="flex items-baseline justify-between gap-3 mb-1.5">
                        <span className="text-xs font-medium" style={{ color: "var(--c-60)" }}>{STEP_LABEL[s.step] ?? s.step}</span>
                        <span className="text-[10px] tabular-nums" style={{ color: "var(--c-45)" }}>
                          {s.kieCredits > 0 && <span className="font-semibold" style={{ color: "var(--c-70)" }}>{compactNumber(s.kieCredits)} cr</span>}
                          {s.kieCredits > 0 && extras.length > 0 && " · "}
                          {extras.join(" · ")}
                        </span>
                      </div>
                      <div className="w-full rounded-full h-1.5" style={{ background: "oklch(1 0 0 / 0.08)" }}>
                        <div className="h-1.5 rounded-full transition-all" style={{ width: `${pct}%`, background: PURPLE }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
