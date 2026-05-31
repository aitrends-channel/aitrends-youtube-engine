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

  // Recompute word count when script is set externally (e.g. loaded from DB)
  useEffect(() => {
    if (isStreaming) return;
    setWordCount(script ? script.trim().split(/\s+/).filter(Boolean).length : 0);
  }, [script, isStreaming]);

  const startStreaming = useCallback(
    async (projectId: string, analysis: unknown, topic: string) => {
      streamingRef.current = true;
      setScript("");
      setWordCount(0);
      setIsStreaming(true);
      setError(null);

      // Animator state — refs so the tick closure sees fresh values
      const bufferedRef    = { current: "" };
      const displayedLen   = { current: 0 };
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
        const res = await fetch("/api/workflow/script", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, analysis, topic }),
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

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const payload = JSON.parse(line.slice(6));
              if (payload.text) bufferedRef.current += payload.text;
              // payload.done is handled by streamDoneRef + final tick below
            } catch {
              // ignore partial chunk parse errors
            }
          }
        }
        streamDoneRef.current = true;
      } catch (err) {
        if (animator) clearTimeout(animator);
        setError(err instanceof Error ? err.message : "Streaming failed");
        setIsStreaming(false);
        streamingRef.current = false;
      }
    },
    []
  );

  return { script, setScript, isStreaming, streamingRef, wordCount, error, startStreaming };
}
