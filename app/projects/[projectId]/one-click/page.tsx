"use client";

import { useState, useEffect } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { OneClickProgress } from "@/components/one-click/OneClickProgress";
import { OneClickConfigPanel } from "@/components/one-click/OneClickConfigPanel";
import { OneClickShell } from "@/components/one-click/OneClickShell";
import { startOneClick } from "@/lib/one-click/kickoff";
import { Spinner } from "@/components/ui/spinner";
import { ONE_CLICK_HIDDEN } from "@/lib/feature-flags";
import { useRouter } from "next/navigation";

const fetcher = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));

interface PageProps { params: { projectId: string } }

// Live "watch it run" view for a 1Click project — the kickoff redirects
// here, and the dashboard's running badge links here. The orchestrator
// advances the project server-side; this page reflects it and nudges the
// tick while open. Header-only chrome via OneClickShell.
//
// A user who lands here without 1Click configured gets the setup stepper in
// place, one screen after the other, rather than being sent to the Setup
// page. Finishing it engages 1Click on this project and the same view flips
// straight to the live run.
export default function OneClickProgressPage({ params }: PageProps) {
  const { projectId } = params;
  const router = useRouter();
  // Flag off: don't render a live-run view for a feature users can't start.
  useEffect(() => {
    if (ONE_CLICK_HIDDEN) router.replace(`/projects/${projectId}/topic`);
  }, [router, projectId]);
  const { data: cfg, mutate: mutateCfg } = useSWR<{ configured: boolean }>(
    "/api/one-click/config", fetcher,
  );
  const [starting, setStarting] = useState(false);

  const needsSetup = cfg ? !cfg.configured : false;

  async function handleSaved() {
    setStarting(true);
    try {
      // Engage autopilot now that a config exists. Safe here: this branch
      // only renders when the config was missing, which means /start would
      // have refused with not_configured, so no run is already in flight.
      await startOneClick(projectId);
      toast.success("1Click engaged. We'll take it from here.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "1Click start failed");
    } finally {
      // Either way, revalidate so the view moves on to the live run — the
      // progress panel is also where a failed engage is worth showing.
      await mutateCfg();
      setStarting(false);
    }
  }

  return (
    <OneClickShell status={!cfg ? undefined : starting ? "Starting" : needsSetup ? "Setup" : "Live run"}>
      {!cfg || starting ? (
        <div className="flex items-center justify-center gap-2 py-20 text-sm" style={{ color: "var(--c-45)" }}>
          <Spinner size={14} /> {starting ? "Starting your video…" : "Loading…"}
        </div>
      ) : needsSetup ? (
        <>
          <div className="mb-6 rounded-2xl px-4 py-3 text-sm leading-relaxed"
            style={{
              background: "oklch(0.72 0.25 285 / 0.08)",
              border: "1px solid oklch(0.72 0.25 285 / 0.25)",
              color: "var(--c-80)",
            }}>
            Answer a few screens and this video starts straight after. You only do this once.
          </div>
          <OneClickConfigPanel mode="stepper" onSaved={handleSaved} />
        </>
      ) : (
        <OneClickProgress projectId={projectId} />
      )}
    </OneClickShell>
  );
}
