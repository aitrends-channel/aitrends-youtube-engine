"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import useSWR from "swr";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { OneClickConfigPanel } from "@/components/one-click/OneClickConfigPanel";
import { OneClickShell } from "@/components/one-click/OneClickShell";
import { useChannelUrl } from "@/components/one-click/ChannelStep";
import {
  forkAndStartOneClick,
  createAndStartOneClickForChannel,
} from "@/lib/one-click/kickoff";
import type { OneClickConfig } from "@/lib/one-click/config";
import { Spinner } from "@/components/ui/spinner";

const fetcher = (url: string) => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(r.status)));

// The 1Click entry view. Ways in, all ending at the live run:
//
//   ?new=1              brand-new niche
//   ?from=<projectId>   new video in an existing niche
//   ?next=<path>        hand back to a flow that owns its own kickoff
//   (none)              opened directly to edit defaults
//
// Setup, when needed, runs here as a stepper — content type is its FIRST
// screen, so it's saved once as an account default. A configured user
// starting a new niche is then only asked for a channel, in a modal ON THIS
// VIEW. Project-less on purpose: nothing is created until setup is done, so
// an abandoned setup can't leave an orphan project behind or burn a niche
// slot against the user's plan limit.
//
// Suspense-wrapped below: useSearchParams() opts this page out of
// prerendering unless it sits under a boundary.
function OneClickSetup() {
  const router = useRouter();
  const params = useSearchParams();
  const isNewNiche = params.get("new") === "1";
  const from = params.get("from");
  const next = params.get("next");

  const { data: cfg, mutate: mutateCfg } = useSWR<{ configured: boolean; config: OneClickConfig }>(
    "/api/one-click/config", fetcher,
  );
  const [starting, setStarting] = useState(false);

  const needsSetup = cfg ? !cfg.configured : false;
  const contentType = cfg?.config?.contentType ?? "long";
  const channel = useChannelUrl(contentType);

  // A configured user with a new niche pending only needs to name a channel.
  const askForChannel = isNewNiche && !!cfg && !needsSetup && !starting;

  async function startNewNiche() {
    const plan = await channel.resolve();
    if (!plan) return;
    setStarting(true);
    try {
      const projectId = await createAndStartOneClickForChannel({
        channelUrl: plan.channelUrl,
        contentType,
        info: plan.info,
      });
      toast.success("1Click engaged. We'll take it from here.");
      router.replace(`/projects/${projectId}/one-click`);
    } catch (err) {
      setStarting(false);
      toast.error(err instanceof Error ? err.message : "1Click start failed");
    }
  }

  async function handleSaved() {
    await mutateCfg();
    // Existing niche: the channel is already on the project, so go.
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
    // New niche: now configured, so the channel modal below takes over.
    if (isNewNiche) return;
    if (next) {
      toast.success("1Click is ready.");
      router.replace(next);
      return;
    }
    toast.success("1Click is ready. Start a video from your dashboard.");
    router.push("/dashboard");
  }

  return (
    <OneClickShell status={!cfg ? undefined : starting ? "Starting" : needsSetup ? "Setup" : "Configured"}>
      {!cfg || starting ? (
        <div className="flex items-center justify-center gap-2 py-20 text-sm" style={{ color: "var(--c-45)" }}>
          <Spinner size={14} /> {starting ? "Starting your video…" : "Loading…"}
        </div>
      ) : (
        <>
          <div className="mb-6 rounded-2xl px-4 py-3 text-sm leading-relaxed"
            style={{
              background: "oklch(0.72 0.25 285 / 0.08)",
              border: "1px solid oklch(0.72 0.25 285 / 0.25)",
              color: "var(--c-80)",
            }}>
            {!needsSetup
              ? "1Click is set up. Adjust anything below and the changes apply to future runs."
              : isNewNiche || from
                ? "Answer a few screens and your video starts straight after. You only do this once."
                : next
                  ? "Answer a few screens and we pick up right where you left off. You only do this once."
                  : "Answer a few screens and 1Click can make whole videos hands-off. You only do this once."}
          </div>
          <OneClickConfigPanel mode="stepper" onSaved={handleSaved} />
        </>
      )}

      {/* Channel prompt — a modal on THIS view, not on the dashboard. Content
          type isn't asked here: it's already saved in the config. */}
      <Dialog open={askForChannel} onOpenChange={(open) => { if (!open) router.push("/dashboard"); }}>
        <DialogContent className="sm:max-w-md bg-[var(--bg-panel)] text-[var(--c-90)] ring-[var(--bd-card)]">
          <DialogHeader>
            <DialogTitle>New niche with 1Click</DialogTitle>
            <DialogDescription className="text-[var(--c-55)]">
              Paste the channel to model. Your saved 1Click defaults cover everything else.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-1">{channel.node}</div>
          <button
            onClick={startNewNiche}
            disabled={!channel.ready}
            className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-40 cursor-pointer"
            style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
          >
            Start 1Click
          </button>
        </DialogContent>
      </Dialog>
    </OneClickShell>
  );
}

export default function OneClickSetupPage() {
  return (
    <Suspense
      fallback={
        <OneClickShell>
          <div className="flex items-center justify-center gap-2 py-20 text-sm" style={{ color: "var(--c-45)" }}>
            <Spinner size={14} /> Loading…
          </div>
        </OneClickShell>
      }
    >
      <OneClickSetup />
    </Suspense>
  );
}
