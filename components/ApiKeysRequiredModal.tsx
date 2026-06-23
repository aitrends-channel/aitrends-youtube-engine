"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

interface Props {
  /** Which of the two required keys are missing. Drives the body copy
   *  so the message tells the user exactly what's left. */
  missing: { kie: boolean; elevenlabs: boolean };
  onClose: () => void;
}

// Pre-niche gate for paid users. /api/me/api-keys-status reports
// whether the user has entered both KIE + ElevenLabs keys; this modal
// fires from createProject() in the dashboard when bothSet is false.
// Bypassed for admins (env-var fallback is acceptable there).
export function ApiKeysRequiredModal({ missing, onClose }: Props) {
  const router = useRouter();
  const [navigating, setNavigating] = useState(false);

  const missingLabels: string[] = [];
  if (missing.kie) missingLabels.push("KIE");
  if (missing.elevenlabs) missingLabels.push("ElevenLabs");
  const missingText = missingLabels.length === 2
    ? "your KIE and ElevenLabs API keys"
    : missingLabels.length === 1
      ? `your ${missingLabels[0]} API key`
      : "your API keys";

  function goToSetup() {
    setNavigating(true);
    router.push("/setup");
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !navigating) onClose(); }}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Add your API keys first</DialogTitle>
          <DialogDescription>
            Niches generate scripts, images, video, and voiceover under your own API quotas — so we need {missingText} on file before you can start one. Takes about 5 minutes.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <button
            onClick={goToSetup}
            disabled={navigating}
            className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-60"
            style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
          >
            {navigating ? (
              <span className="inline-flex items-center justify-center gap-2">
                <Spinner size={14} className="text-white" />
                Opening setup…
              </span>
            ) : "Go to setup"}
          </button>
          <button
            onClick={onClose}
            disabled={navigating}
            className="flex-1 py-2 rounded-xl text-sm font-medium transition-all bg-white text-zinc-700 ring-1 ring-zinc-300 hover:bg-zinc-100 disabled:opacity-40"
          >
            Cancel
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
