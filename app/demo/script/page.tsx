"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { DemoNav } from "@/components/demo/DemoNav";
import { DemoBanner } from "@/components/demo/DemoBanner";
import { DEMO_DATA } from "@/lib/demo-data";

type Phase = "loading" | "done";

export default function DemoScriptPage() {
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [phase, setPhase] = useState<Phase>("loading");
  const [displayedScript, setDisplayedScript] = useState("");
  const scriptContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const saved = sessionStorage.getItem("demo_topic");
    setTopic(saved ?? DEMO_DATA.videoIdeas[0]);
  }, []);

  useEffect(() => {
    let loadingTimer: ReturnType<typeof setTimeout>;
    let typeInterval: ReturnType<typeof setInterval>;

    loadingTimer = setTimeout(() => {
      setPhase("done");
      let charIndex = 0;
      const fullScript = DEMO_DATA.script;

      typeInterval = setInterval(() => {
        charIndex = Math.min(charIndex + 8, fullScript.length);
        setDisplayedScript(fullScript.slice(0, charIndex));

        if (charIndex >= fullScript.length) {
          clearInterval(typeInterval);
        }
      }, 16);
    }, 2000);

    return () => {
      clearTimeout(loadingTimer);
      clearInterval(typeInterval);
    };
  }, []);

  useEffect(() => {
    if (scriptContainerRef.current) {
      scriptContainerRef.current.scrollTop = scriptContainerRef.current.scrollHeight;
    }
  }, [displayedScript]);

  const scriptDone = displayedScript.length >= DEMO_DATA.script.length;

  return (
    <div className="flex h-screen" style={{ background: "var(--bg-page-2)" }}>
      <DemoNav currentStep={2} />
      <div className="flex-1 flex flex-col min-h-0">
        <DemoBanner onSubscribe={() => router.push("/dashboard")} />
        <main className="flex-1 flex flex-col overflow-hidden">
        <div
          className="flex items-center justify-between px-8 py-4 shrink-0"
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

        <div className="flex-1 overflow-y-auto p-8">
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
                    className="w-full min-h-[560px] max-h-[560px] overflow-y-auto text-sm leading-8 font-sans whitespace-pre-wrap"
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

              {scriptDone && (
                <div className="mt-6 flex justify-end">
                  <button
                    onClick={() => router.push("/demo/visuals")}
                    className="px-6 py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                    style={{
                      background: "oklch(0.72 0.25 285)",
                      color: "var(--bg-page-2)",
                      boxShadow: "0 0 16px oklch(0.72 0.25 285 / 0.3)",
                    }}
                  >
                    Continue to Visuals →
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
        </main>
      </div>
    </div>
  );
}
