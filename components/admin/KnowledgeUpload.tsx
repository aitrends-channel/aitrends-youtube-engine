"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Upload } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";

// Upload a document into the knowledge base.
//
// Read in the browser and posted as ordinary notes, because that is all a note
// is: a title and some text the agent gets on every question. Keeping upload on
// the same path means there is one place a note can come from, and one place to
// edit or retract it afterwards.
//
// Long files are split into parts. Everything enabled here is appended to every
// prompt, so a 40KB document as a single note would cost tokens on every
// question a customer ever asks — parts can be disabled individually once you
// see which ones the agent actually needs.

/** Text only. A PDF or DOCX read as text is mojibake, and parsing them belongs
 *  server-side if it is ever worth doing. */
const ACCEPT = ".md,.txt,.markdown,.csv,.json,text/plain,text/markdown";
const MAX_FILE_BYTES = 200_000;
/** Comfortably under the server's per-note limit, leaving room for the title. */
const CHUNK_CHARS = 3_500;

/** Split on blank lines so a part never starts mid-sentence. Falls back to a
 *  hard cut for text with no paragraph breaks at all. */
function chunk(text: string): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= CHUNK_CHARS) return [clean];

  const parts: string[] = [];
  let current = "";
  for (const para of clean.split(/\n{2,}/)) {
    const block = para.trim();
    if (!block) continue;
    if (block.length > CHUNK_CHARS) {
      if (current) { parts.push(current); current = ""; }
      for (let i = 0; i < block.length; i += CHUNK_CHARS) parts.push(block.slice(i, i + CHUNK_CHARS));
      continue;
    }
    if ((current ? current.length + 2 : 0) + block.length > CHUNK_CHARS) {
      parts.push(current);
      current = block;
    } else {
      current = current ? `${current}\n\n${block}` : block;
    }
  }
  if (current) parts.push(current);
  return parts;
}

export function KnowledgeUpload({ onUploaded }: { onUploaded: () => void }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);

  async function handle(file: File) {
    if (file.size > MAX_FILE_BYTES) {
      toast.error(`That file is ${Math.round(file.size / 1000)}KB. Keep uploads under 200KB.`);
      return;
    }
    setBusy(true);
    try {
      const text = await file.text();
      if (!text.trim()) throw new Error("That file is empty.");
      const parts = chunk(text);
      const base = file.name.replace(/\.[^.]+$/, "").slice(0, 90);

      // Sequential on purpose: sort_order follows insertion, so the parts stay
      // in the document's own order.
      for (let i = 0; i < parts.length; i++) {
        const res = await fetch("/api/admin/support-knowledge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: parts.length > 1 ? `${base} (${i + 1}/${parts.length})` : base,
            content: parts[i],
          }),
        });
        if (!res.ok) throw new Error((await res.json()).error ?? "Upload failed");
      }
      onUploaded();
      toast.success(parts.length > 1 ? `Added as ${parts.length} notes.` : "Added.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <>
      <input ref={inputRef} type="file" accept={ACCEPT} className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void handle(f); }} />
      <button type="button" onClick={() => inputRef.current?.click()} disabled={busy}
        title="Text and Markdown files, under 200KB"
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-80 disabled:opacity-40 cursor-pointer"
        style={{ background: "oklch(0 0 0 / 0.04)", color: "var(--c-65)", border: "1px solid oklch(0 0 0 / 0.12)" }}>
        {busy ? <Spinner size={13} /> : <Upload size={13} />}
        {busy ? "Uploading…" : "Upload doc"}
      </button>
    </>
  );
}
