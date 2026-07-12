"use client";

import { useState, useEffect, useRef } from "react";
import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { DemoNav } from "@/components/demo/DemoNav";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { DemoStepCostCard } from "@/components/demo/DemoStepCostCard";
import { DemoStepBalanceCard } from "@/components/demo/DemoStepBalanceCard";
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
  // How the script gets written — mirrors the real step. "choose" shows the
  // AI / manual picker; "ai" streams a generated draft; "manual" opens an
  // empty editable textarea. If we return to an already-generated script,
  // start in "ai" so the existing draft shows instead of the picker.
  const [scriptMode, setScriptMode] = useState<"choose" | "ai" | "manual">(
    state.scriptPhase === "done" ? "ai" : "choose"
  );
  const [regenCount, setRegenCount] = useState(0);
  // Pause/resume state mirrors the production script page so the demo
  // shows the same Stop → Resume/Cancel pattern users will encounter in
  // a real run. charIndexRef carries position across the pause so
  // Resume picks up exactly where Stop left off.
  const [isPaused, setIsPaused] = useState(false);
  const charIndexRef = useRef(0);
  const typeIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scriptContainerRef = useRef<HTMLDivElement>(null);

  function clearTyper() {
    if (typeIntervalRef.current) {
      clearInterval(typeIntervalRef.current);
      typeIntervalRef.current = null;
    }
  }

  function startTyping() {
    clearTyper();
    typeIntervalRef.current = setInterval(() => {
      charIndexRef.current = Math.min(charIndexRef.current + 8, DEMO_DATA.script.length);
      setDisplayedScript(DEMO_DATA.script.slice(0, charIndexRef.current));
      if (charIndexRef.current >= DEMO_DATA.script.length) clearTyper();
    }, 16);
  }

  useEffect(() => {
    // Only the AI path streams a script. Manual/choose modes never auto-run.
    if (scriptMode !== "ai") return;
    // Returning to an already-generated script — show it, don't regenerate.
    if (regenCount === 0 && state.scriptPhase === "done") {
      setDisplayedScript(DEMO_DATA.script);
      charIndexRef.current = DEMO_DATA.script.length;
      return;
    }

    update({ scriptPhase: "loading" });
    setDisplayedScript("");
    setIsPaused(false);
    charIndexRef.current = 0;

    const loadingTimer = setTimeout(() => {
      update({ scriptPhase: "done" });
      startTyping();
    }, 2000);

    return () => {
      clearTimeout(loadingTimer);
      clearTyper();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scriptMode, regenCount]);

  function chooseAI() {
    setScriptMode("ai");
  }

  function chooseManual() {
    clearTyper();
    setIsPaused(false);
    setDisplayedScript("");
    charIndexRef.current = 0;
    setScriptMode("manual");
    // Note: scriptPhase is intentionally left as-is. The script card renders
    // for manual via the isManual flag (not phase), and flipping phase to
    // "done" here would prematurely mark the topic step "locked".
  }

  function handleRegenerate() {
    // From a manual draft this is the "Generate with AI" action; from an AI
    // draft it's "Regenerate". Both switch to AI mode and re-run the stream.
    setScriptMode("ai");
    setRegenCount((c) => c + 1);
  }

  function handleStop() {
    clearTyper();
    setIsPaused(true);
  }

  function handleResume() {
    setIsPaused(false);
    startTyping();
  }

  function handleCancelDraft() {
    setIsPaused(false);
    clearTyper();
    setDisplayedScript("");
    charIndexRef.current = 0;
    // Re-run the loading → typing cycle from scratch so the demo
    // visibly returns to the "fresh start" state, mirroring what the
    // production Cancel does.
    setRegenCount((c) => c + 1);
  }

  useEffect(() => {
    if (scriptContainerRef.current) {
      scriptContainerRef.current.scrollTop = scriptContainerRef.current.scrollHeight;
    }
  }, [displayedScript]);

  const phase = state.scriptPhase;
  const isManual = scriptMode === "manual";
  const scriptDone = displayedScript.length >= DEMO_DATA.script.length;
  // Streaming states only apply to the AI path — manual is a plain editor.
  // Active = typing right now, not paused, not finished.
  const isStreaming = scriptMode === "ai" && phase === "done" && !scriptDone && !isPaused;
  // Paused-draft = some content shown, typing halted by user, not done.
  const isPausedDraft = scriptMode === "ai" && phase === "done" && !scriptDone && isPaused && displayedScript.length > 0;
  // The Continue bar shows once there's a finished AI script or any manual text.
  const canContinue = (scriptMode === "ai" && scriptDone) || (isManual && displayedScript.trim().length > 0);

  return (
    <div className="flex h-screen" style={{ background: "var(--bg-page-2)" }}>
      <DemoNav currentStep={2} />
      <div className="flex-1 flex flex-col min-h-0">
        <DemoBanner />
        <main className="flex-1 flex flex-col overflow-hidden lg:px-[15px]">
        <div
          className="flex items-center justify-between px-5 sm:px-8 py-3 sm:py-4 shrink-0"
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
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <DemoStepCostCard column="script" />
              <DemoStepBalanceCard />
            </div>
          </div>
          <div />
        </div>

        <div className="flex-1 overflow-y-auto px-5 sm:px-8 py-4 sm:py-8 pb-[160px]">
          {/* Choice screen — pick how the script gets written. Nothing runs
              until the user chooses, mirroring the real step. */}
          {scriptMode === "choose" && (
            <div className="max-w-xl mx-auto">
              <div className="text-center space-y-5 p-10 rounded-2xl"
                style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Topic</p>
                  <p className="text-base font-medium" style={{ color: "var(--c-90)" }}>{topic}</p>
                </div>
                <div className="flex flex-col sm:flex-row items-stretch justify-center gap-3">
                  <button
                    onClick={chooseAI}
                    className="px-8 py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                    style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                  >
                    Generate with AI
                  </button>
                  <button
                    onClick={chooseManual}
                    className="px-8 py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                    style={{ background: "transparent", border: "1px solid var(--bd-8)", color: "var(--c-60)" }}
                  >
                    Write manually
                  </button>
                </div>
                <p className="text-xs" style={{ color: "var(--c-40)" }}>
                  AI matches your channel&apos;s style and length · manual gives you full control
                </p>
              </div>
            </div>
          )}

          {scriptMode === "ai" && phase === "loading" && (
            <div className="text-center space-y-5 p-10 rounded-2xl"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
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

          {((scriptMode === "ai" && phase === "done") || isManual) && (
            <div className="lg:mb-[100px]">
              <div className="rounded-2xl overflow-hidden"
                style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
                <div
                  className="flex items-center justify-between px-5 py-3"
                  style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-card-subtle)" }}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <div
                      className="w-2 h-2 rounded-full"
                      style={{
                        background: isStreaming
                          ? "oklch(0.72 0.25 285)"
                          : isPausedDraft
                            ? "oklch(0.72 0.18 65)"
                            : "oklch(0.55 0.15 145)",
                        boxShadow: isStreaming
                          ? "0 0 6px oklch(0.72 0.25 285)"
                          : isPausedDraft
                            ? "0 0 6px oklch(0.72 0.18 65 / 0.6)"
                            : "none",
                      }}
                    />
                    <span className="text-xs font-medium" style={{ color: "var(--c-50)" }}>
                      {isStreaming ? "Generating…" : isPausedDraft ? "Draft — paused" : "Script"}
                    </span>
                    {isStreaming && (
                      <button
                        onClick={handleStop}
                        className="ml-2 text-[10px] font-medium px-2 py-0.5 rounded-md transition-all hover:opacity-90"
                        style={{ background: "oklch(0.6 0.22 25 / 0.1)", border: "1px solid oklch(0.6 0.22 25 / 0.3)", color: "oklch(0.7 0.22 25)" }}
                      >
                        Stop
                      </button>
                    )}
                    {isPausedDraft && (
                      <>
                        <button
                          onClick={handleResume}
                          className="ml-1 text-[11px] font-semibold px-2.5 py-1 rounded-md transition-all hover:opacity-90"
                          style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                        >
                          Resume
                        </button>
                        <button
                          onClick={handleCancelDraft}
                          className="text-[11px] font-medium px-2.5 py-1 rounded-md transition-all hover:opacity-90"
                          style={{ background: "transparent", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}
                        >
                          Cancel
                        </button>
                      </>
                    )}
                  </div>
                  {(isManual || !scriptDone) && (
                    <span className="text-xs font-mono" style={{ color: "oklch(0.72 0.25 285)" }}>
                      {displayedScript.split(/\s+/).filter(Boolean).length} words
                    </span>
                  )}
                </div>

                <div className="relative p-6">
                  {isManual ? (
                    <textarea
                      value={displayedScript}
                      onChange={(e) => setDisplayedScript(e.target.value)}
                      placeholder="Write your script here..."
                      className="w-full min-h-[200px] max-h-[50vh] sm:min-h-[560px] sm:max-h-[560px] overflow-y-auto bg-transparent text-sm leading-8 resize-none outline-none font-sans"
                      style={{ color: "var(--c-90)", caretColor: "oklch(0.72 0.25 285)" }}
                    />
                  ) : (
                    <div
                      ref={scriptContainerRef}
                      className="w-full min-h-[200px] max-h-[50vh] sm:min-h-[560px] sm:max-h-[560px] overflow-y-auto text-sm leading-8 font-sans whitespace-pre-wrap"
                      style={{ color: "var(--c-90)" }}
                    >
                      {displayedScript}
                      {!scriptDone && !isPausedDraft && (
                        <span
                          className="inline-block w-0.5 h-[18px] align-middle rounded-full animate-pulse ml-0.5"
                          style={{ background: "oklch(0.72 0.25 285)" }}
                        />
                      )}
                    </div>
                  )}
                </div>
              </div>

            </div>
          )}
        </div>
        </main>
      </div>
      {canContinue && (
        <div className="fixed bottom-0 left-0 md:left-64 right-0 z-20 py-3"
          style={{ background: "var(--bg-header-2)", borderTop: "1px solid var(--bd-6)", backdropFilter: "blur(12px)" }}>
          <div className="px-5 sm:px-8 flex gap-3">
            <button
              onClick={handleRegenerate}
              disabled={navigating}
              className="flex-1 py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all hover:opacity-90 flex items-center justify-center gap-2"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
            >
              <RefreshCw size={14} strokeWidth={2.5} />
              {isManual ? "Generate with AI" : "Regenerate"}
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
