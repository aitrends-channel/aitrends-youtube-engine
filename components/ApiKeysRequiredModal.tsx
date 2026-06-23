"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";

interface Props {
  onClose: () => void;
}

// Pre-niche gate for paid users. /api/me/api-keys-status reports
// whether the user has entered both KIE + ElevenLabs keys; this modal
// fires from createProject() in the dashboard when bothSet is false.
// Bypassed for admins (env-var fallback is acceptable there).
export function ApiKeysRequiredModal({ onClose }: Props) {
  const router = useRouter();
  const [navigating, setNavigating] = useState(false);

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
            You need to setup your API keys first.
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
