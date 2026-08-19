"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Send, ChevronDown, ChevronRight, Database } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

// Ask the database something in plain English.
//
// The admin writes prose. The SQL is shown, but collapsed: it is the working, not
// the point, and an admin who wanted to write SQL would not be here. It is one
// click away because an answer whose working is hidden is a rumour, and the first
// thing anyone does with a surprising number is check where it came from.

interface QueryStep {
  sql: string;
  rows: number;
  ms: number;
  error?: string;
  purpose?: string;
}

interface QueryResult {
  answer?: string;
  error?: string;
  trail?: QueryStep[];
  exhausted?: boolean;
}

const cardStyle = { background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.07)" } as const;

// Starting points, not a menu. They exist to show the shape of question that
// works: specific, about data the database actually holds.
const EXAMPLES = [
  "How much has timasidra@gmail.com spent at the prompts step, in KIE credits, on their last 3 videos?",
  "Which paying subscribers renew in the next 14 days?",
  "How many projects reached a finished video this month, and how many stalled before it?",
  "Which users have saved a KIE key but never created a project?",
];

export function QueryPanel() {
  const [question, setQuestion] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [trailOpen, setTrailOpen] = useState(false);

  async function ask(q: string) {
    const text = q.trim();
    if (!text || running) return;
    setRunning(true);
    setResult(null);
    setTrailOpen(false);
    try {
      const res = await fetch("/api/admin/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text }),
      });
      const body = await res.json().catch(() => ({})) as QueryResult;
      if (!res.ok) throw new Error(body.error ?? `Request failed (HTTP ${res.status})`);
      setResult(body);
      // Open the working automatically when there is nothing else to look at, or
      // when a query failed — those are the moments the SQL is the answer.
      if (!body.answer || body.trail?.some((t) => t.error)) setTrailOpen(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : "The query failed";
      setResult({ error: message });
      toast.error(message);
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-bold" style={{ color: "var(--c-88)" }}>Query</h2>
        <p className="text-xs mt-1 leading-relaxed" style={{ color: "var(--c-45)" }}>
          Ask about the production database in plain English. Read-only: it can look at anything and change nothing.
        </p>
      </div>

      <div className="rounded-2xl p-4 space-y-3" style={cardStyle}>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, since these are questions rather than documents.
            // Shift+Enter still breaks a line for a long one.
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void ask(question); }
          }}
          rows={3}
          disabled={running}
          placeholder="How much has this user spent at the prompts step this month?"
          className="w-full rounded-xl px-3 py-2.5 text-sm outline-none resize-y disabled:opacity-60"
          style={{ background: "var(--bg-input)", color: "var(--c-88)", border: "1px solid var(--bd-10)" }}
        />
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px]" style={{ color: "var(--c-35)" }}>
            Enter to ask, Shift+Enter for a new line
          </span>
          <button
            onClick={() => void ask(question)}
            disabled={running || !question.trim()}
            className="px-4 py-2 rounded-xl text-sm font-semibold inline-flex items-center gap-2 transition-all hover:opacity-90 disabled:opacity-40"
            style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
          >
            {running ? <><Spinner size={14} /> Looking…</> : <><Send size={14} /> Ask</>}
          </button>
        </div>
      </div>

      {!result && !running && (
        <div className="rounded-2xl p-4 space-y-2" style={cardStyle}>
          <p className="text-xs font-semibold" style={{ color: "var(--c-55)" }}>Try one of these</p>
          {EXAMPLES.map((ex) => (
            <button
              key={ex}
              onClick={() => { setQuestion(ex); void ask(ex); }}
              className="block w-full text-left text-xs px-3 py-2 rounded-lg transition-all hover:opacity-80"
              style={{ background: "var(--bg-track)", color: "var(--c-60)" }}
            >
              {ex}
            </button>
          ))}
        </div>
      )}

      {result?.error && (
        <div className="rounded-2xl p-4 text-sm" style={{ background: "oklch(0.6 0.19 25 / 0.1)", border: "1px solid oklch(0.6 0.19 25 / 0.3)", color: "oklch(0.7 0.2 25)" }}>
          {result.error}
        </div>
      )}

      {result?.answer && (
        <div className="rounded-2xl p-4" style={cardStyle}>
          <p className="text-sm leading-relaxed whitespace-pre-wrap" style={{ color: "var(--c-80)" }}>
            {result.answer}
          </p>
          {result.exhausted && (
            <p className="text-[11px] mt-2" style={{ color: "oklch(0.7 0.18 75)" }}>
              Stopped after the query limit rather than guessing from a half-finished look.
            </p>
          )}
        </div>
      )}

      {!!result?.trail?.length && (
        <div className="rounded-2xl overflow-hidden" style={cardStyle}>
          <button
            onClick={() => setTrailOpen((o) => !o)}
            className="w-full flex items-center gap-2 px-4 py-3 text-xs font-semibold transition-all hover:opacity-80"
            style={{ color: "var(--c-55)" }}
          >
            {trailOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <Database size={13} />
            {result.trail.length} quer{result.trail.length === 1 ? "y" : "ies"} run
            {result.trail.some((t) => t.error) && (
              <span style={{ color: "oklch(0.7 0.2 25)" }}>
                · {result.trail.filter((t) => t.error).length} failed
              </span>
            )}
          </button>
          {trailOpen && (
            <div className="px-4 pb-4 space-y-3">
              {result.trail.map((t, i) => (
                <div key={i} className="rounded-lg p-3 space-y-1.5" style={{ background: "var(--bg-track)" }}>
                  <div className="flex items-center justify-between gap-2 text-[11px]" style={{ color: "var(--c-45)" }}>
                    <span className="truncate">{t.purpose ?? `Query ${i + 1}`}</span>
                    <span className="shrink-0 tabular-nums">
                      {t.error ? "failed" : `${t.rows} row${t.rows === 1 ? "" : "s"}`} · {t.ms}ms
                    </span>
                  </div>
                  <pre className="text-[11px] font-mono whitespace-pre-wrap break-all" style={{ color: "var(--c-70)" }}>
                    {t.sql || "(no statement)"}
                  </pre>
                  {t.error && (
                    <p className="text-[11px]" style={{ color: "oklch(0.7 0.2 25)" }}>{t.error}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
