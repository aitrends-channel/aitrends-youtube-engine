"use client";

interface DemoBannerProps {
  onSubscribe: () => void;
}

export function DemoBanner({ onSubscribe }: DemoBannerProps) {
  return (
    <div
      className="fixed top-0 left-64 right-0 z-40 flex items-center justify-between px-6 py-2 text-xs"
      style={{
        background: "oklch(0.72 0.25 285 / 0.12)",
        borderBottom: "1px solid oklch(0.72 0.25 285 / 0.2)",
        color: "var(--c-65)",
      }}
    >
      <span>✨ You&apos;re viewing a demo — subscribe to run this on your own channel.</span>
      <button
        onClick={onSubscribe}
        className="ml-4 shrink-0 px-3 py-1 rounded-lg text-xs font-semibold transition-all hover:opacity-90"
        style={{
          background: "oklch(0.72 0.25 285)",
          color: "oklch(0.06 0 0)",
        }}
      >
        Subscribe Now →
      </button>
    </div>
  );
}
