"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";

export default function DemoFinishPage() {
  const router = useRouter();

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center px-6 py-16"
      style={{ background: "var(--bg-page)" }}
    >
      <div className="max-w-lg w-full text-center space-y-8">

        {/* Logo */}
        <div className="flex justify-center">
          <Link href="/demo/dashboard" className="block transition-opacity hover:opacity-80">
            <div className="w-[52px] h-[52px] rounded-2xl overflow-hidden">
              <Image src="/heclus-icon-white.svg" alt="Heclus" width={52} height={52} className="w-full h-full object-cover" />
            </div>
          </Link>
        </div>

        {/* Heading */}
        <div className="space-y-3">
          <h1 className="text-3xl font-bold tracking-tight">Your video is ready.</h1>
          <p className="text-base leading-relaxed" style={{ color: "var(--c-55)" }}>
            That&apos;s exactly what Heclus does — for your channel, your niche, every week.
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-4">
          <div
            className="rounded-2xl px-6 py-5 text-center"
            style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}
          >
            <p className="text-2xl font-bold" style={{ color: "var(--brand-text)" }}>
              ~8 minutes
            </p>
            <p className="text-xs mt-1.5" style={{ color: "var(--c-45)" }}>Full production time</p>
          </div>
          <div
            className="rounded-2xl px-6 py-5 text-center"
            style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}
          >
            <p className="text-2xl font-bold" style={{ color: "var(--brand-text)" }}>
              0 manual edits
            </p>
            <p className="text-xs mt-1.5" style={{ color: "var(--c-45)" }}>Required</p>
          </div>
        </div>

        {/* CTA */}
        <div className="space-y-3 pt-2">
          <button
            onClick={() => router.push("/dashboard")}
            className="w-full py-4 rounded-2xl text-base font-bold transition-all hover:opacity-90"
            style={{
              background: "oklch(0.72 0.25 285)",
              color: "oklch(0.06 0 0)",
              boxShadow: "0 0 32px oklch(0.72 0.25 285 / 0.35)",
            }}
          >
            Subscribe &amp; Start Creating →
          </button>
          <button
            onClick={() => router.push("/demo/generate")}
            className="text-xs transition-all hover:opacity-80"
            style={{ color: "var(--c-40)" }}
          >
            ← Back to demo
          </button>
        </div>
      </div>
    </div>
  );
}
