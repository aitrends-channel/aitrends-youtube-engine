"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { ThemeToggle } from "@/components/ThemeToggle";

export function DemoTopBar() {
  const router = useRouter();
  return (
    <header
      className="flex items-center justify-between px-6 py-3 shrink-0"
      style={{
        background: "var(--bg-header)",
        borderBottom: "1px solid var(--bd-6)",
        backdropFilter: "blur(12px)",
        zIndex: 20,
      }}
    >
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-xl overflow-hidden shrink-0">
          <Image src="/heclus-icon-white.svg" alt="Heclus" width={32} height={32} className="w-full h-full object-cover" />
        </div>
        <span className="font-bold text-sm tracking-tight" style={{ color: "var(--c-90)" }}>Heclus</span>
        <span
          className="text-xs font-semibold px-1.5 py-0.5 rounded"
          style={{
            background: "oklch(0.72 0.25 285 / 0.15)",
            border: "1px solid oklch(0.72 0.25 285 / 0.3)",
            color: "oklch(0.72 0.25 285)",
          }}
        >
          Demo
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-xs" style={{ color: "var(--c-50)" }}>
          Subscribe to use on your own channel
        </span>
        <button
          onClick={() => router.push("/dashboard")}
          className="px-3 py-1.5 rounded-lg text-xs font-semibold transition-all hover:opacity-90"
          style={{ background: "oklch(0.72 0.25 285)", color: "oklch(0.06 0 0)" }}
        >
          Subscribe Now →
        </button>
        <ThemeToggle />
      </div>
    </header>
  );
}
