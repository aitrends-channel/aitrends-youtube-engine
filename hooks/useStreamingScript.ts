"use client";

import { useState, useCallback, useRef, useEffect } from "react";

// KIE's Claude proxy buffers SSE streams server-side — all deltas
// arrive in one burst after a long wait. To preserve the "live typing"
// feel users expect from script generation, we buffer incoming text
// and reveal it on a steady animator. With real streaming (if we ever
// switch providers) the animator just keeps pace with arrivals — no
// extra latency added.
const FRAME_MS = 30;
const CHARS_PER_FRAME = 70;  // ≈2300 chars/sec → ~8s for a 3k-word script

export function useStreamingScript() {
  const [script, setScript] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [wordCount, setWordCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Prevents DB-loaded project data from overwriting an in-progress stream
  const streamingRef = useRef(false);
  // AbortController for the live fetch — lets stopStreaming() kill the
  // SSE connection immediately instead of waiting for the next server
  // -side run-id check (~1.5 s of generated text in the worst case).
  const abortRef = useRef<AbortController | null>(null);

  // Recompute word count when script is set externally (e.g. loaded from DB)
  useEffect(() => {
    if (isStreaming) return;
    setWordCount(script ? script.trim().split(/\s+/).filter(Boolean).length : 0);
  }, [script, isStreaming]);

  const startStreaming = useCallback(
    async (
      projectId: string,
      analysis: unknown,
      topic: string,
      opts?: { mode?: "fresh" | "continue"; startWith?: string }
    ) => {
      const mode = opts?.mode ?? "fresh";
      const startWith = opts?.startWith ?? "";

      streamingRef.current = true;
      // Continue mode pre-loads the partial so the user sees their
      // saved draft instantly; new deltas append cleanly to it. Fresh
      // mode clears as before.
      setScript(startWith);
      setWordCount(startWith ? startWith.trim().split(/\s+/).filter(Boolean).length : 0);
      setIsStreaming(true);
      setError(null);

      // Animator state — refs so the tick closure sees fresh values
      const bufferedRef    = { current: startWith };
      const displayedLen   = { current: startWith.length };
      const streamDoneRef  = { current: false };
      let animator: ReturnType<typeof setTimeout> | null = null;

      const tick = () => {
        const pending = bufferedRef.current.length - displayedLen.current;
        if (pending <= 0) {
          if (streamDoneRef.current) {
            // Final flush — set the full text, end the stream.
            setScript(bufferedRef.current);
            const n = bufferedRef.current.trim().split(/\s+/).filter(Boolean).length;
            setWordCount(n);
            setIsStreaming(false);
            streamingRef.current = false;
            animator = null;
            return;
          }
          // Waiting on more text — keep ticking.
          animator = setTimeout(tick, FRAME_MS);
          return;
        }
        const nextEnd = displayedLen.current + Math.min(CHARS_PER_FRAME, pending);
        displayedLen.current = nextEnd;
        const slice = bufferedRef.current.slice(0, nextEnd);
        setScript(slice);
        setWordCount(slice.trim().split(/\s+/).filter(Boolean).length);
        animator = setTimeout(tick, FRAME_MS);
      };

      try {
        abortRef.current = new AbortController();
        const res = await fetch("/api/workflow/script", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, analysis, topic, mode }),
          signal: abortRef.current.signal,
        });

        if (!res.ok) throw new Error(await res.text());
        if (!res.body) throw new Error("No response body");

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // Kick off the animator immediately so the UI starts ticking.
        animator = setTimeout(tick, 0);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          let serverError: string | null = null;
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const payload = JSON.parse(line.slice(6));
              if (payload.text) bufferedRef.current += payload.text;
              // Length-policing trim: route emits { replace: "<final
              // trimmed script>" } when the streamed text overshot the
              // target and got trimmed back to a sentence boundary.
              // Overwrite the buffer so the displayed script matches
              // what landed in the DB. displayedLen reset triggers the
              // animator to repaint from the start.
              if (typeof payload.replace === "string") {
                bufferedRef.current = payload.replace;
                displayedLen.current = 0;
              }
              if (payload.error) serverError = payload.error;
              // payload.done is handled by streamDoneRef + final tick below
            } catch {
              // ignore partial chunk parse errors
            }
          }
          if (serverError) throw new Error(serverError);
        }
        streamDoneRef.current = true;
      } catch (err) {
        if (animator) clearTimeout(animator);
        // Swallow AbortError — the user clicked Stop, this is expected.
        // Any other error is a real failure worth surfacing.
        const isAbort = err instanceof Error && err.name === "AbortError";
        if (!isAbort) setError(err instanceof Error ? err.message : "Streaming failed");
        setIsStreaming(false);
        streamingRef.current = false;
      } finally {
        abortRef.current = null;
      }
    },
    []
  );

  // Two-sided cancellation: abort the local SSE fetch immediately, then
  // null script_active_run_id on the server so the route's next
  // assertScriptRunActive trips and exits without overwriting anything.
  // Safe to call when nothing is streaming — it'll just clear any
  // stale server-side run id (e.g., a previous tab's left-over).
  const stopStreaming = useCallback(async (projectId: string): Promise<void> => {
    if (abortRef.current) {
      try { abortRef.current.abort(); } catch { /* ignore */ }
      abortRef.current = null;
    }
    setIsStreaming(false);
    streamingRef.current = false;
    try {
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script_active_run_id: null }),
      });
    } catch {
      // Best effort — the local abort is the most important signal.
    }
  }, []);

  return { script, setScript, isStreaming, streamingRef, wordCount, error, startStreaming, stopStreaming };
}
