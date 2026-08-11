"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Stethoscope, ChevronDown, ChevronRight, Copy, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import type { Diagnosis, DiagnoseResponse } from "@/app/api/admin/diagnose/route";

// Probes one ticket or inbound email and shows the result in place. Not
// persisted: the result lives until it is closed, so the shape can change
// without a migration while we learn what is useful on real tickets.
//
// The panel leads with two things: what is wrong, and what to do. Anyone
// opening this is mid-ticket and wants those two answers, so the reasoning,
// what was ruled out, and the raw evidence sit behind toggles rather than
// competing with them.

const CONFIDENCE_TONE: Record<Diagnosis["confidence"], { bg: string; fg: string; border: string; label: string }> = {
  confirmed: { bg: "oklch(0.55 0.15 145 / 0.12)", fg: "oklch(0.42 0.15 145)", border: "oklch(0.55 0.15 145 / 0.3)", label: "Sure" },
  likely:    { bg: "oklch(0.6 0.18 75 / 0.12)",   fg: "oklch(0.45 0.16 75)",  border: "oklch(0.6 0.18 75 / 0.3)",   label: "Probably" },
  unknown:   { bg: "oklch(0 0 0 / 0.05)",          fg: "var(--c-50)",          border: "oklch(0 0 0 / 0.1)",         label: "Not sure" },
};

export function DiagnoseButton({ ticketId, emailId }: { ticketId?: string; emailId?: string }) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<DiagnoseResponse | null>(null);
  const [showWorking, setShowWorking] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);

  async function run() {
    setRunning(true);
    try {
      const res = await fetch("/api/admin/diagnose", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(ticketId ? { ticketId } : { emailId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Probe failed");
      setResult(data as DiagnoseResponse);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Probe failed");
    } finally {
      setRunning(false);
    }
  }

  function close() {
    setResult(null);
    setShowWorking(false);
    setShowEvidence(false);
  }

  const tone = result ? CONFIDENCE_TONE[result.diagnosis.confidence] : null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={run}
          disabled={running}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-50 cursor-pointer"
          style={{ background: "oklch(0.62 0.15 220)", color: "white" }}
        >
          {running ? <Spinner size={13} /> : <Stethoscope size={13} />}
          {running ? "Probing…" : result ? "Probe again" : "Probe"}
        </button>
        {result && !running && (
          <button
            type="button"
            onClick={close}
            className="px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80 cursor-pointer"
            style={{ background: "oklch(0 0 0 / 0.04)", color: "var(--c-55)", border: "1px solid oklch(0 0 0 / 0.08)" }}
          >
            Close
          </button>
        )}
      </div>

      {result && tone && (() => {
        const d = result.diagnosis;
        // One list instead of two headed sections: a tick for what turned out
        // fine, a dot for what points at the cause. Scannable without a label
        // on every line.
        const working = [
          ...d.evidence.map((line) => ({ line, kind: "why" as const })),
          ...d.checkedAndRuledOut.map((line) => ({ line, kind: "ok" as const })),
        ];
        return (
          <div className="rounded-xl p-4 space-y-4" style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.08)" }}>

            {/* What is wrong — the line someone opens this for. */}
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm leading-relaxed" style={{ color: "var(--c-88)" }}>{d.cause}</p>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider"
                    style={{ background: tone.bg, color: tone.fg, border: `1px solid ${tone.border}` }}>
                    {tone.label}
                  </span>
                  {d.needsHuman && (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider"
                      style={{ background: "oklch(0.6 0.19 25 / 0.1)", color: "oklch(0.45 0.15 25)", border: "1px solid oklch(0.6 0.19 25 / 0.3)" }}>
                      Needs a person
                    </span>
                  )}
                </div>
              </div>
              <button type="button" onClick={close} title="Close" aria-label="Close probe result"
                className="shrink-0 p-1 rounded-lg transition-opacity hover:opacity-70 cursor-pointer"
                style={{ color: "var(--c-45)" }}>
                <X size={13} />
              </button>
            </div>

            {/* What to do. */}
            {d.fix && (
              <div className="rounded-lg px-3 py-2.5"
                style={{ background: "oklch(0.62 0.15 220 / 0.06)", border: "1px solid oklch(0.62 0.15 220 / 0.18)" }}>
                <p className="text-[10px] font-semibold uppercase tracking-wider mb-1" style={{ color: "oklch(0.45 0.13 220)" }}>Do this</p>
                <p className="text-sm leading-relaxed" style={{ color: "var(--c-85)" }}>{d.fix}</p>
              </div>
            )}

            {working.length > 0 && (
              <div>
                <button type="button" onClick={() => setShowWorking((v) => !v)}
                  className="inline-flex items-center gap-1 text-[11px] font-medium transition-opacity hover:opacity-70 cursor-pointer"
                  style={{ color: "var(--c-50)" }}>
                  {showWorking ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                  How this was worked out
                </button>
                {showWorking && (
                  <ul className="mt-2 space-y-1">
                    {working.map(({ line, kind }, i) => (
                      <li key={i} className="text-xs leading-relaxed pl-4 relative"
                        style={{ color: kind === "why" ? "var(--c-65)" : "var(--c-50)" }}>
                        <span className="absolute left-0" style={{ color: kind === "why" ? "var(--c-40)" : "oklch(0.55 0.15 145)" }}>
                          {kind === "why" ? "·" : "✓"}
                        </span>
                        {line}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {d.replyDraft && (
              <div>
                <div className="flex items-center justify-between gap-2 mb-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--c-45)" }}>Draft reply</p>
                  <button type="button"
                    onClick={() => { void navigator.clipboard.writeText(d.replyDraft); toast.success("Copied"); }}
                    className="inline-flex items-center gap-1 text-[10px] font-medium transition-opacity hover:opacity-70 cursor-pointer"
                    style={{ color: "oklch(0.62 0.15 220)" }}>
                    <Copy size={11} /> Copy
                  </button>
                </div>
                <p className="text-xs leading-relaxed whitespace-pre-wrap rounded-lg px-3 py-2"
                  style={{ background: "oklch(0 0 0 / 0.03)", border: "1px solid oklch(0 0 0 / 0.06)", color: "var(--c-70)" }}>
                  {d.replyDraft}
                </p>
                <p className="text-[10px] mt-1" style={{ color: "var(--c-35)" }}>Read it before sending.</p>
              </div>
            )}

            {/* Kept, because a result nobody can check is worth little — just
                not in the way of the two answers above. */}
            <div>
              <button type="button" onClick={() => setShowEvidence((v) => !v)}
                className="inline-flex items-center gap-1 text-[11px] font-medium transition-opacity hover:opacity-70 cursor-pointer"
                style={{ color: "var(--c-45)" }}>
                {showEvidence ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                Raw data checked
              </button>
              {showEvidence && (
                <pre className="mt-2 text-[10px] leading-relaxed overflow-x-auto rounded-lg px-3 py-2 max-h-[360px] overflow-y-auto"
                  style={{ background: "oklch(0 0 0 / 0.04)", border: "1px solid oklch(0 0 0 / 0.06)", color: "var(--c-60)" }}>
                  {JSON.stringify(result.gathered, null, 2)}
                </pre>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
