"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Send } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

// Ask the database something in plain English, and get plain English back.
//
// Deliberately no SQL in the interface. An admin here is asking a question, not
// reviewing a query, and showing the statements turned an answer into homework.
// The route still records what it ran and returns it, so the queries are there in
// the response for debugging; the panel reports only how many there were, which
// is the one part of the working that tells the reader something: whether it
// actually looked.

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

const cardStyle = { background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.10)" } as const;


// Renders the model's answer: paragraphs, plus any pipe-delimited table turned
// into a real one.
//
// A markdown dependency would be a lot of bundle for the one construct this
// needs, and a table is the only rich thing an answer here ever contains. If the
// parse ever fails the text still reads, which is the right way for this to
// degrade.
function AnswerBody({ text }: { text: string }) {
  const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  // A markdown separator row (|---|---|) is scaffolding, not data.
  const isSeparator = (l: string) => /^\s*\|[\s|:-]+\|\s*$/.test(l);
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  // The prompt asks for no emphasis, but a stray ** should not reach the reader
  // as asterisks if the model forgets.
  const clean = (t: string) => t.replace(/\*\*/g, "");

  const blocks: { type: "text" | "table"; lines: string[] }[] = [];
  for (const line of text.split("\n")) {
    const type = isRow(line) ? "table" : "text";
    const last = blocks[blocks.length - 1];
    if (last && last.type === type) last.lines.push(line);
    else blocks.push({ type, lines: [line] });
  }

  return (
    <div className="space-y-3">
      {blocks.map((block, i) => {
        if (block.type === "text") {
          const body = clean(block.lines.join("\n")).trim();
          if (!body) return null;
          return (
            <p key={i} className="text-base leading-relaxed whitespace-pre-wrap" style={{ color: "var(--c-88)" }}>
              {body}
            </p>
          );
        }

        const rows = block.lines.filter((l) => !isSeparator(l)).map(cells);
        if (rows.length === 0) return null;
        const [header, ...body] = rows;
        return (
          <div key={i} className="overflow-x-auto rounded-lg" style={{ border: "1px solid var(--bd-10)" }}>
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "var(--bg-track)" }}>
                  {header.map((h, c) => (
                    <th key={c} className="text-left font-semibold px-3 py-2 whitespace-nowrap" style={{ color: "var(--c-55)" }}>
                      {clean(h)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {body.map((r, ri) => (
                  <tr key={ri} style={{ borderTop: "1px solid var(--bd-8)" }}>
                    {r.map((cell, ci) => (
                      <td
                        key={ci}
                        // Numbers right-aligned and tabular so a column of them
                        // can be scanned down rather than read across.
                        className={`px-3 py-2 ${/^[-+]?[\d.,%$]+$/.test(cell.trim()) ? "text-right tabular-nums" : ""}`}
                        style={{ color: "var(--c-75)" }}
                      >
                        {clean(cell)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </div>
  );
}

export function QueryPanel() {
  const [question, setQuestion] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<QueryResult | null>(null);

  async function ask(q: string) {
    const text = q.trim();
    if (!text || running) return;
    setRunning(true);
    setResult(null);
    try {
      const res = await fetch("/api/admin/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: text }),
      });
      const body = await res.json().catch(() => ({})) as QueryResult;
      if (!res.ok) throw new Error(body.error ?? `Request failed (HTTP ${res.status})`);
      setResult(body);
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
          className="w-full rounded-xl px-4 py-3 text-base outline-none resize-y disabled:opacity-60"
          style={{ background: "var(--bg-input)", color: "var(--c-88)", border: "1px solid var(--bd-10)" }}
        />
        <div className="flex items-center justify-between gap-3">
          {/* The keyboard hint is only useful before you have asked. While a
              question is in flight this is the spot the eye is already on, so it
              carries the progress instead. */}
          {running ? (
            <span className="text-xs font-medium animate-pulse" style={{ color: "var(--brand-text)" }}>
              Querying…
            </span>
          ) : (
            <span className="text-xs" style={{ color: "var(--c-35)" }}>
              Enter to ask, Shift+Enter for a new line
            </span>
          )}
          <button
            onClick={() => void ask(question)}
            disabled={running || !question.trim()}
            aria-label={running ? "Querying" : "Ask"}
            title={running ? "Querying…" : "Ask"}
            className="px-5 py-2.5 rounded-xl text-base font-semibold inline-flex items-center justify-center gap-2 min-w-[92px] transition-all hover:opacity-90 disabled:opacity-40"
            style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
          >
            {running ? <Spinner size={16} /> : <><Send size={14} /> Ask</>}
          </button>
        </div>
      </div>

      {result?.error && (
        <div className="rounded-2xl p-4 text-base" style={{ background: "oklch(0.6 0.19 25 / 0.1)", border: "1px solid oklch(0.6 0.19 25 / 0.3)", color: "oklch(0.7 0.2 25)" }}>
          {result.error}
        </div>
      )}

      {result?.answer && (
        <div className="rounded-2xl p-4" style={cardStyle}>
          <AnswerBody text={result.answer} />
          {result.exhausted && (
            <p className="text-xs mt-2" style={{ color: "oklch(0.7 0.18 75)" }}>
              Stopped after the query limit rather than guessing from a half-finished look.
            </p>
          )}
        </div>
      )}

      {!!result?.trail?.length && (
        <p className="text-xs px-1" style={{ color: "var(--c-35)" }}>
          {/* Count only. A query that failed is usually the model probing for a
              column name and missing, which is how the loop is supposed to work
              — with no SQL on screen there is nothing the reader could do about
              it, so reporting failures here only worried them. */}
          Answered from {result.trail.length} quer{result.trail.length === 1 ? "y" : "ies"}.
        </p>
      )}

    </div>
  );
}
