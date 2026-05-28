"use client";

import { useState, useEffect, useRef } from "react";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { DemoNav } from "@/components/demo/DemoNav";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { DEMO_DATA } from "@/lib/demo-data";
import { useDemoState } from "@/lib/demo-context";

export default function DemoScriptPage() {
  const router = useRouter();
  const { state, update } = useDemoState();
  const topic = state.selectedTopic || DEMO_DATA.videoIdeas[0];
  const [navigating, setNavigating] = useState(false);
  const [displayedScript, setDisplayedScript] = useState(
    state.scriptPhase === "done" ? DEMO_DATA.script : ""
  );
  const [regenCount, setRegenCount] = useState(0);
  const scriptContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (regenCount === 0 && state.scriptPhase === "done") return;

    update({ scriptPhase: "loading" });
    setDisplayedScript("");

    let charIndex = 0;
    const fullScript = DEMO_DATA.script;
    let typeInterval: ReturnType<typeof setInterval>;

    const loadingTimer = setTimeout(() => {
      update({ scriptPhase: "done" });
      typeInterval = setInterval(() => {
        charIndex = Math.min(charIndex + 8, fullScript.length);
        setDisplayedScript(fullScript.slice(0, charIndex));
        if (charIndex >= fullScript.length) clearInterval(typeInterval);
      }, 16);
    }, 2000);

    return () => {
      clearTimeout(loadingTimer);
      clearInterval(typeInterval);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [regenCount]);

  function handleRegenerate() {
    setRegenCount((c) => c + 1);
  }

  useEffect(() => {
    if (scriptContainerRef.current) {
      scriptContainerRef.current.scrollTop = scriptContainerRef.current.scrollHeight;
    }
  }, [displayedScript]);

  const phase = state.scriptPhase;
  const scriptDone = displayedScript.length >= DEMO_DATA.script.length;

  return (
    <div className="flex h-screen" style={{ background: "var(--bg-page-2)" }}>
      <DemoNav currentStep={2} />
      <div className="flex-1 flex flex-col min-h-0">
        <DemoBanner />
        <main className="flex-1 flex flex-col overflow-hidden">
        <div
          className="flex items-center justify-between px-4 sm:px-8 py-3 sm:py-4 shrink-0"
          style={{
            borderBottom: "1px solid var(--bd-6)",
            background: "var(--bg-header-2)",
            backdropFilter: "blur(12px)",
          }}
        >
          <div>
            <h1 className="font-bold text-lg">Script Editor</h1>
            {topic && (
              <p className="text-xs truncate max-w-sm mt-0.5" style={{ color: "var(--c-50)" }}>
                {topic}
              </p>
            )}
          </div>
          <div />
        </div>

        <div className="flex-1 overflow-y-auto p-4 sm:p-8 pb-[160px]">
          {phase === "loading" && (
            <div className="max-w-xl mx-auto text-center space-y-5 p-10 rounded-2xl"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
              <div className="flex flex-col items-center gap-4">
                <span className="w-8 h-8 border-2 border-current border-t-transparent rounded-full animate-spin inline-block"
                  style={{ color: "oklch(0.72 0.25 285)" }} />
                <p className="text-sm font-medium" style={{ color: "var(--c-65)" }}>
                  Generating your script…
                </p>
                <p className="text-xs" style={{ color: "var(--c-45)" }}>
                  Analyzing style DNA and writing to match your channel&apos;s voice
                </p>
              </div>
            </div>
          )}

          {phase === "done" && (
            <div className="max-w-3xl mx-auto">
              <div className="rounded-2xl overflow-hidden"
                style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
                <div
                  className="flex items-center justify-between px-5 py-3"
                  style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-card-subtle)" }}
                >
                  <div className="flex items-center gap-2">
                    <div
                      className="w-2 h-2 rounded-full"
                      style={{
                        background: scriptDone ? "oklch(0.55 0.15 145)" : "oklch(0.72 0.25 285)",
                        boxShadow: scriptDone ? "none" : "0 0 6px oklch(0.72 0.25 285)",
                      }}
                    />
                    <span className="text-xs font-medium" style={{ color: "var(--c-50)" }}>
                      {scriptDone ? "Script" : "Generating…"}
                    </span>
                  </div>
                  {!scriptDone && (
                    <span className="text-xs font-mono" style={{ color: "oklch(0.72 0.25 285)" }}>
                      {displayedScript.split(/\s+/).filter(Boolean).length} words
                    </span>
                  )}
                </div>

                <div className="relative p-6">
                  <div
                    ref={scriptContainerRef}
                    className="w-full min-h-[200px] max-h-[50vh] sm:min-h-[560px] sm:max-h-[560px] overflow-y-auto text-sm leading-8 font-sans whitespace-pre-wrap"
                    style={{ color: "var(--c-90)" }}
                  >
                    {displayedScript}
                    {!scriptDone && (
                      <span
                        className="inline-block w-0.5 h-[18px] align-middle rounded-full animate-pulse ml-0.5"
                        style={{ background: "oklch(0.72 0.25 285)" }}
                      />
                    )}
                  </div>
                </div>
              </div>

            </div>
          )}
        </div>
        </main>
      </div>
      {scriptDone && (
        <div className="fixed bottom-0 left-0 md:left-64 right-0 z-20 py-3 px-4 sm:px-8"
          style={{ background: "var(--bg-header-2)", borderTop: "1px solid var(--bd-6)", backdropFilter: "blur(12px)" }}>
          <div className="max-w-3xl mx-auto flex gap-3">
            <button
              onClick={handleRegenerate}
              disabled={navigating}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all hover:opacity-90 flex items-center justify-center gap-2"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
            >
              <RefreshCw size={14} strokeWidth={2.5} />
              Regenerate
            </button>
            <button
              onClick={() => { setNavigating(true); setTimeout(() => router.push("/demo/visuals"), 500); }}
              disabled={navigating}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60 transition-all hover:opacity-90"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
            >
              {navigating ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Preparing visuals…
                </span>
              ) : "Continue →"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
