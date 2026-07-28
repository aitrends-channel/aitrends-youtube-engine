"use client";

import { useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { toast } from "sonner";
import { OneClickConfigPanel } from "@/components/one-click/OneClickConfigPanel";
import { OneClickShell } from "@/components/one-click/OneClickShell";
import { NewNicheModal } from "@/components/one-click/NewNicheModal";
import {
  forkAndStartOneClick,
  createAndStartOneClickForChannel,
  type KickoffChannelInfo,
} from "@/lib/one-click/kickoff";
import { Spinner } from "@/components/ui/spinner";

const fetcher = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));

type NichePlan = { channelUrl: string; contentType: "long" | "shorts" | "both"; info: KickoffChannelInfo };

// The 1Click entry view. Three ways in, all ending at the live run:
//
//   ?new=1              brand-new niche: collect content type + channel in a
//                       modal here, then (setup if needed) create + engage.
//   ?from=<projectId>   existing niche: fork it and engage once setup is done.
//   ?next=<path>        hand back to a flow that owns its own kickoff.
//   (none)              someone opened this directly to edit their defaults.
//
// Project-less on purpose: the config is checked BEFORE anything is created,
// so an abandoned setup can't leave an orphan project behind or burn a niche
// slot against the user's plan limit.
export default function OneClickSetupPage() {
  const router = useRouter();
  const params = useSearchParams();
  const isNewNiche = params.get("new") === "1";
  const from = params.get("from");
  const next = params.get("next");

  const { data: cfg, mutate: mutateCfg } = useSWR<{ configured: boolean }>("/api/one-click/config", fetcher);
  const [starting, setStarting] = useState(false);
  // Set once the modal has a validated channel. Held here so setup can run
  // in between without losing what the user already told us.
  const [plan, setPlan] = useState<NichePlan | null>(null);

  const needsSetup = cfg ? !cfg.configured : false;

  async function launch(p: NichePlan) {
    setStarting(true);
    try {
      const projectId = await createAndStartOneClickForChannel(p);
      toast.success("1Click engaged. We'll take it from here.");
      router.replace(`/projects/${projectId}/one-click`);
    } catch (err) {
      setStarting(false);
      toast.error(err instanceof Error ? err.message : "1Click start failed");
    }
  }

  // The modal has a channel: run setup first if it's missing, otherwise go.
  function handleNicheReady(p: NichePlan) {
    setPlan(p);
    if (!needsSetup) void launch(p);
  }

  async function handleSaved() {
    // New niche waiting on setup — start it now, same view.
    if (plan) { await mutateCfg(); void launch(plan); return; }
    // Hand back to a flow that does its own kickoff (the channel step).
    if (next) {
      toast.success("1Click is ready.");
      router.replace(next);
      return;
    }
    if (from) {
      setStarting(true);
      try {
        const projectId = await forkAndStartOneClick(from);
        toast.success("1Click engaged. We'll take it from here.");
        router.replace(`/projects/${projectId}/one-click`);
      } catch (err) {
        setStarting(false);
        toast.error(err instanceof Error ? err.message : "1Click start failed");
      }
      return;
    }
    toast.success("1Click is ready. Start a video from your dashboard.");
    router.push("/dashboard");
  }

  // Collect the channel before anything else on the new-niche path.
  const showNicheModal = isNewNiche && !plan && !starting;
  // Setup runs after the modal (or immediately, on the other paths).
  const showSetup = !starting && needsSetup && (!isNewNiche || !!plan);

  return (
    <OneClickShell status={!cfg ? undefined : starting ? "Starting" : needsSetup ? "Setup" : "Configured"}>
      {!cfg || starting ? (
        <div className="flex items-center justify-center gap-2 py-20 text-sm" style={{ color: "var(--c-45)" }}>
          <Spinner size={14} /> {starting ? "Starting your video…" : "Loading…"}
        </div>
      ) : showNicheModal ? (
        <NewNicheModal onReady={handleNicheReady} />
      ) : showSetup ? (
        <>
          <div className="mb-6 rounded-2xl px-4 py-3 text-sm leading-relaxed"
            style={{
              background: "oklch(0.72 0.25 285 / 0.08)",
              border: "1px solid oklch(0.72 0.25 285 / 0.25)",
              color: "var(--c-80)",
            }}>
            {plan || from
              ? "Answer a few screens and your video starts straight after. You only do this once."
              : next
                ? "Answer a few screens and we pick up right where you left off. You only do this once."
                : "Answer a few screens and 1Click can make whole videos hands-off. You only do this once."}
          </div>
          <OneClickConfigPanel mode="stepper" onSaved={handleSaved} />
        </>
      ) : (
        <>
          <div className="mb-6 rounded-2xl px-4 py-3 text-sm leading-relaxed"
            style={{
              background: "oklch(0.72 0.25 285 / 0.08)",
              border: "1px solid oklch(0.72 0.25 285 / 0.25)",
              color: "var(--c-80)",
            }}>
            1Click is set up. Adjust anything below and the changes apply to future runs.
          </div>
          <OneClickConfigPanel mode="stepper" onSaved={handleSaved} />
        </>
      )}
    </OneClickShell>
  );
}
