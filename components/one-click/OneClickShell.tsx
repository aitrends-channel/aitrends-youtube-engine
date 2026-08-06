"use client";

import { useRouter } from "next/navigation";
import { ArrowLeft, Wand2 } from "lucide-react";

// Chrome for the 1Click views: a header and nothing else. Deliberately no
// WizardNav — 1Click is hands-off, so the step-by-step workflow sidebar
// has nothing to navigate (and it used to be fed a hardcoded
// currentState={1}, so it always highlighted "Channel" however far the run
// had actually got).
//
// Shared by the per-project live view and the project-less setup view so
// the two look like one place.
export function OneClickShell({
  status,
  children,
}: {
  /** Short right-aligned label, e.g. "Setup" or "Live run". */
  status?: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  return (
    <div className="min-h-screen" style={{ background: "var(--bg-page-2)" }}>
      <header
        className="sticky top-0 z-30"
        style={{
          background: "var(--bg-header-2)",
          borderBottom: "1px solid var(--bd-6)",
          backdropFilter: "blur(12px)",
        }}
      >
        <div className="max-w-5xl mx-auto px-4 sm:px-8 py-3.5 flex items-center gap-3">
          <button
            onClick={() => router.push("/dashboard")}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80 cursor-pointer"
            style={{ color: "var(--c-55)" }}
          >
            <ArrowLeft size={14} /> Dashboard
          </button>
          <span className="w-px h-5" style={{ background: "var(--bd-6)" }} />
          <span
            className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}
          >
            <Wand2 size={15} style={{ color: "var(--brand-text)" }} />
          </span>
          <h1 className="text-sm font-bold" style={{ color: "var(--c-90)" }}>1Click</h1>
          {status && (
            <span className="ml-auto text-xs" style={{ color: "var(--c-45)" }}>{status}</span>
          )}
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-8 py-6 pb-16">{children}</main>
    </div>
  );
}
