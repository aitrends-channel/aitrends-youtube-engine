"use client";

import { useState, useCallback, useRef } from "react";

export function useStreamingScript() {
  const [script, setScript] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [wordCount, setWordCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Prevents DB-loaded project data from overwriting an in-progress stream
  const streamingRef = useRef(false);

  const startStreaming = useCallback(
    async (projectId: string, analysis: unknown, topic: string) => {
      streamingRef.current = true;
      setScript("");
      setWordCount(0);
      setIsStreaming(true);
      setError(null);

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
              if (payload.text) {
                setScript((prev) => {
                  const next = prev + payload.text;
                  setWordCount(next.trim().split(/\s+/).length);
                  return next;
                });
              }
              if (payload.done) {
                setWordCount(payload.wordCount ?? 0);
              }
            } catch {
              // ignore partial chunk parse errors
            }
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Streaming failed");
      } finally {
        setIsStreaming(false);
        streamingRef.current = false;
      }
    },
    []
  );

  return { script, setScript, isStreaming, streamingRef, wordCount, error, startStreaming };
}
