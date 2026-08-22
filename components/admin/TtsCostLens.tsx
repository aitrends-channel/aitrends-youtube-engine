"use client";

import { useState } from "react";
import useSWR from "swr";

interface TtsCostAnalysis {
  windowDays: number;
  kie: {
    totalCredits: number;
    taskCount: number;
    avgCreditsPerTask: number;
    usdPerCredit: number | null;
    totalUsd: number | null;
  };
  beats: {
    totalChars: number;
    beatCount: number;
    avgCharsPerBeat: number;
  };
  elevenlabs: {
    usdPerChar: number;
    totalUsd: number;
  };
  derived: {
    creditsPerChar: number | null;
    cheaper: "kie" | "elevenlabs" | "tie" | "unknown";
    kieMinusElUsd: number | null;
  };
}

const fetcher = (url: string) => fetch(url).then((r) => r.ok ? r.json() : Promise.reject(r.status));

const fmtNum = (n: number) => n >= 100 ? Math.round(n).toLocaleString() : n.toFixed(2);
const fmtUsd = (n: number) => `$${n.toFixed(2)}`;

// Verifies the "KIE is cheaper than direct ElevenLabs" assumption
// against actual usage. The decision was made when scripts were
// generated as long chunks; per-beat splitting changed the math
// (per-task pricing penalizes short text). Plug in the KIE USD rate
// from a recent invoice to get a real comparison.
export function TtsCostLens() {
  const [usdPerCredit, setUsdPerCredit] = useState("");
  const [days, setDays] = useState(30);
  const qs = new URLSearchParams({ days: String(days) });
  if (usdPerCredit && Number(usdPerCredit) > 0) qs.set("usdPerCredit", usdPerCredit);
  const { data, isLoading } = useSWR<TtsCostAnalysis>(
    `/api/admin/tts-cost-analysis?${qs.toString()}`,
    fetcher,
    { revalidateOnFocus: false },
  );

  return (
    <div
      className="rounded-2xl w-full max-w-full p-4 space-y-3"
      style={{ background: "white", border: "1px solid oklch(0 0 0 / 0.10)", boxShadow: "0 2px 12px oklch(0 0 0 / 0.05)" }}
    >
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs uppercase tracking-wider" style={{ color: "var(--c-40)" }}>TTS cost lens</p>
          <p className="text-sm" style={{ color: "var(--c-50)" }}>KIE-proxied TTS vs. direct ElevenLabs (~${(0.00018).toFixed(5)}/char)</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs" style={{ color: "var(--c-50)" }}>
            Window
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="ml-1 px-2 py-1 rounded text-xs"
              style={{ background: "oklch(0.97 0 0)", border: "1px solid oklch(0 0 0 / 0.1)" }}
            >
              <option value={7}>7d</option>
              <option value={30}>30d</option>
              <option value={90}>90d</option>
              <option value={365}>1y</option>
            </select>
          </label>
          <label className="text-xs" style={{ color: "var(--c-50)" }}>
            $/credit
            <input
              type="number"
              step="0.000001"
              value={usdPerCredit}
              onChange={(e) => setUsdPerCredit(e.target.value)}
              placeholder="0.000015"
              className="ml-1 px-2 py-1 rounded text-xs w-24"
              style={{ background: "oklch(0.97 0 0)", border: "1px solid oklch(0 0 0 / 0.1)" }}
            />
          </label>
        </div>
      </div>

      {isLoading && <p className="text-xs" style={{ color: "var(--c-50)" }}>Loading…</p>}

      {data && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="KIE tasks" value={fmtNum(data.kie.taskCount)} />
            <Stat label="Avg credits / task" value={fmtNum(data.kie.avgCreditsPerTask)} />
            <Stat label="Beats with audio" value={fmtNum(data.beats.beatCount)} />
            <Stat label="Avg chars / beat" value={fmtNum(data.beats.avgCharsPerBeat)} />
            <Stat label="Total credits" value={fmtNum(data.kie.totalCredits)} />
            <Stat label="Total chars" value={fmtNum(data.beats.totalChars)} />
            <Stat
              label="KIE cost"
              value={data.kie.totalUsd !== null ? fmtUsd(data.kie.totalUsd) : "—"}
              hint={data.kie.totalUsd === null ? "needs $/credit" : undefined}
            />
            <Stat label="EL equivalent" value={fmtUsd(data.elevenlabs.totalUsd)} />
          </div>

          <Verdict data={data} />
        </>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg px-3 py-2" style={{ background: "oklch(0.97 0 0 / 0.8)" }}>
      <p className="text-xs uppercase tracking-wider" style={{ color: "var(--c-40)" }}>{label}</p>
      <p className="text-base font-semibold" style={{ color: "var(--c-90)" }}>{value}</p>
      {hint && <p className="text-xs" style={{ color: "var(--c-50)" }}>{hint}</p>}
    </div>
  );
}

function Verdict({ data }: { data: TtsCostAnalysis }) {
  const { derived, kie, elevenlabs } = data;
  if (derived.cheaper === "unknown") {
    return (
      <p className="text-xs" style={{ color: "var(--c-50)" }}>
        Plug in $/credit above to compare against ElevenLabs direct.
      </p>
    );
  }
  const delta = Math.abs(derived.kieMinusElUsd ?? 0);
  if (derived.cheaper === "kie") {
    return (
      <p className="text-sm font-medium" style={{ color: "oklch(0.55 0.18 145)" }}>
        KIE wins by {fmtUsd(delta)} on this window ({fmtUsd(kie.totalUsd!)} vs. {fmtUsd(elevenlabs.totalUsd)} on ElevenLabs).
      </p>
    );
  }
  if (derived.cheaper === "elevenlabs") {
    return (
      <p className="text-sm font-medium" style={{ color: "oklch(0.6 0.2 25)" }}>
        ElevenLabs would be cheaper by {fmtUsd(delta)} ({fmtUsd(elevenlabs.totalUsd)} vs. {fmtUsd(kie.totalUsd!)} on KIE).
      </p>
    );
  }
  return (
    <p className="text-sm font-medium" style={{ color: "var(--c-60)" }}>
      Roughly tied within 5% ({fmtUsd(kie.totalUsd!)} KIE vs. {fmtUsd(elevenlabs.totalUsd)} EL).
    </p>
  );
}
