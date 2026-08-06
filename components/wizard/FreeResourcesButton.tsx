"use client";

import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";

// Step-specific pill that surfaces the free-tier alternatives page
// scoped to whatever step the user is on (e.g. free TTS on voiceover,
// free image/video providers on generate). Steps opt in by rendering
// this in WizardNav's `topRightExtra` slot — it is NOT wired into
// WizardNav itself, so a step that has no free-tier alternative
// doesn't accidentally advertise one.
export function FreeResourcesButton({ step }: { step: string }) {
  const router = useRouter();
  return (
    <button
      onClick={() => router.push(`/free-resources?step=${encodeURIComponent(step)}`)}
      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80"
      style={{
        background: "oklch(0.72 0.25 285 / 0.08)",
        color: "var(--brand-text)",
        border: "1px solid oklch(0.72 0.25 285 / 0.2)",
      }}
    >
      <Sparkles size={13} />
      Free resources
    </button>
  );
}
