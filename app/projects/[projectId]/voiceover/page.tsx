"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { WizardNav } from "@/components/wizard/WizardNav";
// FreeResourcesButton is temporarily hidden — see comment near
// StepBalanceCard below. Keep the import commented so ESLint's
// no-unused-imports rule stays happy while the JSX usage is out.
// import { FreeResourcesButton } from "@/components/wizard/FreeResourcesButton";
import { useKieActivityStore } from "@/store/kieActivityStore";
import { StepCostCard } from "@/components/StepCostCard";
import { CostTipsModal } from "@/components/CostTipsModal";
import { StepBalanceCard } from "@/components/StepBalanceCard";
import { useProject } from "@/hooks/useProject";
import { useViewerPlan } from "@/lib/admin-view";
import { refreshBalance } from "@/store/balanceStore";
import { TTS_MODEL, TTS_MODELS, ttsCreditsPerKChars } from "@/lib/tts-models";
import { toast } from "sonner";
import useSWR from "swr";
import type { KieModel, Beat } from "@/lib/types";
import { SequentialVoiceoverPreview } from "@/components/voiceover/SequentialVoiceoverPreview";
import { BeatAudioPlayer } from "@/components/voiceover/BeatAudioPlayer";
import { QWEN_VOICES, isQwenVoice } from "@/lib/replicate/tts";
import { AI33_VOICES, AI33_FREE_PROVIDERS, ai33VoicesByGender, isAi33Voice, AI33_CLONE_MAX_SECONDS, AI33_CLONE_MIN_SECONDS } from "@/lib/ai33/tts";
import { trimAudioFile } from "@/lib/audio/trim";
import { SubscriptionModal } from "@/components/SubscriptionModal";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

import { VoiceOption } from "@/components/VoiceOption";
import { FREE_TTS_COMING_SOON } from "@/lib/free-tier-flag";
import { RotateCw, ChevronUp, ChevronDown, Download, Trash2, Plus, X, Upload as UploadIcon, Mic } from "lucide-react";

// Per-beat voiceover step. Each beat shows its own row with status,
// playback, and per-beat retry. A bulk Generate button kicks off all
// stale beats in parallel (server-side concurrency cap respected).
//
// Status sources:
//   • The project's `beats` array carries voiceoverUrl / voiceoverStatus
//     and friends — that's the canonical source after the SSE stream
//     ends or on a fresh page load.
//   • While the SSE is in flight, per-beat status arriving from the
//     server takes precedence via an overlay map so the UI doesn't
//     wait for SWR's 5s poll to reflect each beat's progress.

interface PageProps { params: { projectId: string } }

const fetcher = (url: string) => fetch(url).then((r) => r.json());

type BeatStatus = "pending" | "queued" | "generating" | "done" | "failed";

interface LiveBeatState {
  status: BeatStatus;
  url?: string;
  error?: string;
}

// ── Status pill ─────────────────────────────────────────────────────
function StatusPill({ status }: { status: BeatStatus }) {
  const style = {
    pending:    { bg: "oklch(0.7 0.18 25 / 0.10)",    col: "oklch(0.75 0.18 25)", label: "Pending" },
    queued:     { bg: "oklch(0.72 0.16 70 / 0.12)",   col: "oklch(0.85 0.12 70)", label: "Queued" },
    generating: { bg: "oklch(0.72 0.25 285 / 0.12)",  col: "oklch(0.72 0.25 285)", label: "Generating" },
    done:       { bg: "oklch(0.55 0.15 145 / 0.15)",  col: "oklch(0.7 0.15 145)", label: "Done" },
    failed:     { bg: "oklch(0.6 0.22 25 / 0.12)",    col: "oklch(0.7 0.2 25)",   label: "Failed" },
  }[status];
  return (
    <span className="text-[11px] font-medium px-2 py-0.5 rounded inline-flex items-center gap-1.5"
      style={{ background: style.bg, color: style.col }}>
      {/* Loading spinner is reserved for beats that the worker pool
          is actively processing. "Queued" rows are pre-marked
          upfront (BATCH_SIZE-at-a-time used to limit this; the
          worker-pool change made the queue span the whole stale
          set), so a spinning queued pill on 100+ rows misleads the
          user into thinking every beat is in flight. Static dot for
          queued, spinner only for generating. */}
      {status === "queued" && (
        <span className="inline-block w-1.5 h-1.5 rounded-full" style={{ background: "currentColor", opacity: 0.65 }} />
      )}
      {status === "generating" && (
        <span className="inline-block w-2 h-2 rounded-full border-2 border-current border-t-transparent animate-spin" />
      )}
      {style.label}
    </span>
  );
}


// Monthly free-quota usage bar shared by the free voice providers
// (Qwen perk cap, Google BYO 1M). Mirrors the free-image daily bar
// in ModelPicker.
// Compact two-row layout: the badge and its note share row one with the
// used/cap figure, and the bar sits INLINE on row two between the
// "Monthly quota" caption and the percentage. It was four stacked rows
// (title, badge+figure, caption+percent, full-width bar) which ate
// vertical space above the voice grid for very little information.
interface ClonedVoiceCard {
  id: string;
  name: string;
  voiceId: string;
  sample_url: string | null;
  created_at: string;
}

function FreeQuotaBar({ used, cap, loaded, badge, badgeNote }: { used: number; cap: number; loaded: boolean; badge?: string; badgeNote?: string }) {
  // Exact percent — big caps mean real usage is often <1%, where
  // rounding to an integer shows a misleading "0%".
  const pctRaw = cap > 0 ? Math.min(100, (used / cap) * 100) : 0;
  const pctLabel =
    pctRaw === 0 ? "0%"
    : pctRaw < 1 ? `${pctRaw.toFixed(2)}%`
    : pctRaw < 10 ? `${pctRaw.toFixed(1)}%`
    : `${Math.round(pctRaw)}%`;
  // Any nonzero usage gets at least a ~1% sliver so the green is
  // actually visible even at fractions of a percent.
  const fillWidth = used > 0 ? Math.max(pctRaw, 1) : 0;
  const near = pctRaw >= 90;
  return (
    <div className="rounded-xl px-1 py-1 space-y-1.5">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="flex items-center gap-1.5 min-w-0">
          {badge && (
            <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold shrink-0"
              style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "var(--brand-text)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}>
              {badge}
            </span>
          )}
          {badgeNote && (
            <span className="text-[9px] whitespace-nowrap" style={{ color: "var(--c-45)" }}>
              {badgeNote}
            </span>
          )}
        </span>
        <span className="text-[10px] tabular-nums shrink-0" style={{ color: "var(--c-45)" }}>
          {loaded ? `${used.toLocaleString()} / ${cap.toLocaleString()}` : "…"}
        </span>
      </div>
      <div className="flex items-center gap-2 text-[10px]" style={{ color: "var(--c-45)" }}>
        <span className="shrink-0">Monthly quota</span>
        {/* min-w-0 so the track can shrink instead of pushing the
            percentage out of the row on narrow viewports. */}
        <div className="h-2 rounded-full overflow-hidden flex-1 min-w-0" style={{ background: "var(--bg-track)" }}>
          <div
            className="h-full rounded-full transition-all"
            style={{
              width: `${fillWidth}%`,
              background: near
                ? "oklch(0.72 0.18 65)"
                : "linear-gradient(90deg, oklch(0.7 0.19 150), oklch(0.6 0.2 145))",
            }}
          />
        </div>
        <span className="tabular-nums shrink-0">{loaded ? pctLabel : ""}</span>
      </div>
    </div>
  );
}

export default function VoiceoverPage({ params }: PageProps) {
  // Heclus Credits accounts spend credits, not a vendor's balance, so the
  // confirmations must not name one.
  const { onCredits } = useViewerPlan();
  const { projectId } = params;
  const router = useRouter();
  const { project, mutate } = useProject(projectId);
  const { data: ttsModels } = useSWR<KieModel[]>("/api/kie/models?type=tts", fetcher);

  const beats: Beat[] = useMemo(() => (project?.beats ?? []) as Beat[], [project]);
  const projectVoiceId = (project?.tts_voice_id as string | null | undefined) ?? null;
  const projectTtsModel = (project?.tts_model as string | null | undefined) ?? null;

  // Main scroll container for the per-beat content. Used by the
  // floating jump-to buttons below so users can hop to the first or
  // last beat without having to drag through a long script.
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  // Anchor for "jump to top": stops at the bulk action panel rather
  // than the absolute top of the page (which would scroll past the
  // counts + Generate button into the voice picker — the user wants
  // to land at the actionable controls, not the picker).
  const bulkPanelRef = useRef<HTMLDivElement | null>(null);

  // Voice picker state — defaults to the project's saved voice (i.e.
  // the voice that was actually used to generate any existing beats),
  // else first model of the active gender tab.
  const [selectedVoice, setSelectedVoice] = useState<string | null>(null);
  // Which ElevenLabs model speaks. Hydrated from the project below, and only
  // ever applies to ElevenLabs voices: the free Qwen and ai33 voices are
  // different providers and ignore it entirely.
  const [ttsModel, setTtsModel] = useState<string>(TTS_MODEL);
  const ttsModelHydrated = useRef(false);
  const [voiceTab, setVoiceTab] = useState<"female" | "male" | "custom" | "free">("female");
  // Which paid tab to restore when coming back from Free.
  const [lastPaidTab, setLastPaidTab] = useState<"female" | "male" | "custom">("female");
  // Gender split *inside* the Free tab. Separate from voiceTab so switching
  // Female/Male among the free voices doesn't knock you out of the Free tab.
  const [freeGenderTab, setFreeGenderTab] = useState<"female" | "male">("female");
  // Provider split, one level ABOVE the gender split: "all" merges every
  // provider (the previous behavior), or narrow to one vendor's catalog.
  // Both are server-side filters on /api/generate/tts/voices.
  const [freeProviderTab, setFreeProviderTab] = useState<"all" | "custom" | (typeof AI33_FREE_PROVIDERS)[number]["id"]>("all");
  const [previewingId, setPreviewingId] = useState<string | null>(null);
  // Live ai33 catalog for the Free tab. The tab used to render the 25
  // hardcoded AI33_VOICES; it now pages through /api/generate/tts/voices
  // (thousands of English voices across elevenlabs/minimax/fishaudio/
  // edge). `freeLive` false means the server fell back to the static
  // list — shown with a note rather than silently.
  const [freeVoices, setFreeVoices] = useState<KieModel[]>([]);
  const [freeVoicesLoading, setFreeVoicesLoading] = useState(false);
  const [freeHasMore, setFreeHasMore] = useState(false);
  const [freeLive, setFreeLive] = useState(true);
  const [freePage, setFreePage] = useState(1);
  // Raw input vs. the debounced value that actually hits the API, so
  // typing doesn't fire a request per keystroke.
  const [freeSearch, setFreeSearch] = useState("");
  const [freeSearchQuery, setFreeSearchQuery] = useState("");
  // Voices this user cloned on Heclus's ai33 account. Only ever the
  // caller's own — the shared upstream account holds everyone's.
  const [clones, setClones] = useState<ClonedVoiceCard[]>([]);
  const [cloneMax, setCloneMax] = useState(0);
  const [cloneName, setCloneName] = useState("");
  const [cloneFile, setCloneFile] = useState<File | null>(null);
  const [cloneConsent, setCloneConsent] = useState(false);
  const [cloning, setCloning] = useState(false);
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [deletingClone, setDeletingClone] = useState<string | null>(null);
  // A sample has to come from somewhere: either a file on the user's
  // machine or the mic, since cloning your own voice rarely means you
  // already have a clip lying around.
  const [cloneDuration, setCloneDuration] = useState<number | null>(null);
  const [clonePreviewUrl, setClonePreviewUrl] = useState<string | null>(null);
  const [cloneTrimmed, setCloneTrimmed] = useState(false);
  const [showCloneForm, setShowCloneForm] = useState(false);
  // cloneMax starts at 0, so "no allowance" and "not fetched yet" would
  // otherwise look identical and refuse a Pro user mid-load.
  const [clonesLoaded, setClonesLoaded] = useState(false);
  // Same pattern as the assemble step's Pro-locked resolutions: let the
  // user upgrade in place rather than only being told no. Mounted lazily —
  // most sessions never open it.
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const [userEmail, setUserEmail] = useState("");
  useEffect(() => {
    let cancelled = false;
    createSupabaseBrowserClient().auth.getUser().then(({ data }) => {
      if (!cancelled && data.user?.email) setUserEmail(data.user.email);
    }).catch(() => { /* the modal falls back to an empty email */ });
    return () => { cancelled = true; };
  }, []);
  const [recording, setRecording] = useState(false);
  const [recordSecs, setRecordSecs] = useState(0);
  const cloneFileInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recordSecsRef = useRef(0);
  // Names for ai33 voices the picker hasn't loaded a page containing —
  // a project's saved voice is usually somewhere deep in the catalog.
  // Keyed by voice id, filled lazily by the resolve effect below.
  const [resolvedFreeVoices, setResolvedFreeVoices] = useState<Record<string, KieModel>>({});
  // Sticky bit so a subsequent project SWR update doesn't overwrite an
  // explicit user pick. Only the very first resolution honors
  // projectVoiceId / auto-pick; after that the picker owns the state.
  const voiceResolvedRef = useRef(false);

  // Same sticky rule as the voice: hydrate once from the project, then the
  // picker owns it, so a later SWR refresh cannot undo a fresh choice.
  useEffect(() => {
    if (ttsModelHydrated.current || project === undefined) return;
    ttsModelHydrated.current = true;
    if (projectTtsModel && TTS_MODELS.some((m) => m.id === projectTtsModel)) setTtsModel(projectTtsModel);
  }, [project, projectTtsModel]);

  // Saved as soon as it is chosen rather than on Generate, so a refresh keeps
  // it and a per-beat regen later speaks on the same model as its neighbours.
  const chooseTtsModel = useCallback((id: string) => {
    setTtsModel(id);
    void fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tts_model: id }),
    }).catch(() => { /* the generate call carries it regardless */ });
  }, [projectId]);

  useEffect(() => {
    if (voiceResolvedRef.current) return;
    // Wait for the project to load so we know whether tts_voice_id
    // exists. Without this, ttsModels can arrive first and auto-pick
    // a different voice before projectVoiceId ever shows up — the
    // banner then displays the wrong voice and the staleness math
    // thinks every done beat needs regenerating.
    if (project === undefined) return;
    if (projectVoiceId) {
      setSelectedVoice(projectVoiceId);
      voiceResolvedRef.current = true;
      return;
    }
    // No saved voice → fall back to the first voice in the active
    // tab once the catalog is available.
    if (!ttsModels?.length) return;
    const firstInTab = ttsModels.find((m) => m.tags?.[0]?.toLowerCase() === voiceTab);
    if (firstInTab) {
      setSelectedVoice(firstInTab.id);
      voiceResolvedRef.current = true;
    }
  }, [project, projectVoiceId, ttsModels, voiceTab]);

  // Live overlay — per-beat state from the SSE stream during a run,
  // takes precedence over the project's persisted state until the
  // stream ends and SWR catches up.
  const [liveBeats, setLiveBeats] = useState<Map<number, LiveBeatState>>(new Map());
  const [generating, setGenerating] = useState(false);
  // Free monthly usage for the Free tab's usage bar. Fetched lazily when the
  // Free tab is opened and refreshed after generation so the bar reflects new
  // chars. Declared after `generating` so the effect below can depend on it
  // without a temporal-dead-zone error.
  //
  // ai33TtsCap is the admin-allocated quota (product_config.free_quotas), so
  // the bar shows exactly what the server enforces — never a local guess.
  const [freeTtsUsage, setFreeTtsUsage] = useState<{ qwenTtsChars: number; qwenTtsCap: number; ai33TtsChars: number; ai33TtsCap: number } | null>(null);
  useEffect(() => {
    if (voiceTab !== "free") return;
    let cancelled = false;
    fetch("/api/free-usage")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        // Gate on the cap we actually render: without it there's no honest
        // number to show, so stay unloaded rather than invent one.
        if (cancelled || !d || typeof d.ai33TtsCap !== "number") return;
        setFreeTtsUsage({ qwenTtsChars: d.qwenTtsChars ?? 0, qwenTtsCap: d.qwenTtsCap ?? 0, ai33TtsChars: d.ai33TtsChars ?? 0, ai33TtsCap: d.ai33TtsCap });
      })
      .catch(() => { /* fail-soft: bar just shows "…" */ });
    return () => { cancelled = true; };
  }, [voiceTab, generating]);

  // Never fail quietly here: an empty panel is indistinguishable from
  // "you have no clones", which hid a broken query for a whole session.
  const loadClones = useCallback(async () => {
    try {
      const r = await fetch("/api/voices/clone");
      const d = await r.json().catch(() => null);
      if (!r.ok) {
        setCloneError(d?.error ?? `Couldn't load your cloned voices (${r.status}).`);
        return;
      }
      setClones(d.voices ?? []);
      setCloneMax(d.max ?? 0);
      setClonesLoaded(true);
    } catch (e) {
      setCloneError(`Couldn't load your cloned voices: ${(e as Error).message}`);
    }
  }, []);
  useEffect(() => {
    if (voiceTab === "free") void loadClones();
  }, [voiceTab, loadClones]);

  // ai33 rejects samples outside 3–30s, so check locally rather than make
  // the user wait on an upload that can't succeed.
  const sampleDuration = (file: File) => new Promise<number>((resolve) => {
    const url = URL.createObjectURL(file);
    const audio = new Audio(url);
    const done = (d: number) => { URL.revokeObjectURL(url); resolve(d); };
    audio.onloadedmetadata = () => done(audio.duration);
    audio.onerror = () => done(NaN);
  });

  // Accepts a picked file or a finished recording: measure it, keep a
  // preview so the user can hear what they're about to submit, and reject
  // out-of-range lengths here rather than after a 10MB upload.
  const resetCloneForm = useCallback(() => {
    setCloneName("");
    setCloneFile(null);
    setCloneConsent(false);
    setCloneDuration(null);
    setCloneTrimmed(false);
    setCloneError(null);
    setClonePreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
  }, []);

  // knownSecs comes from the recorder's own clock: MediaRecorder blobs
  // report duration Infinity (no metadata in a streamed container), so
  // measuring one tells us nothing.
  const acceptCloneSample = useCallback(async (file: File, knownSecs?: number) => {
    setCloneError(null);
    let next = file;
    let secs: number | undefined;
    let trimmed = false;
    try {
      const r = await trimAudioFile(file, AI33_CLONE_MAX_SECONDS);
      next = r.file;
      secs = r.duration;
      trimmed = r.trimmed;
    } catch {
      // Undecodable container: keep the file and fall back to whatever
      // length we can establish, rather than blocking on the trim.
      const measured = await sampleDuration(file);
      secs = Number.isFinite(measured) ? measured : knownSecs;
    }
    setCloneFile(next);
    setCloneTrimmed(trimmed);
    setClonePreviewUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return URL.createObjectURL(next); });
    setCloneDuration(secs ?? null);
    // Too long is fixed by trimming; too short can only be re-recorded.
    if (secs !== undefined && secs < AI33_CLONE_MIN_SECONDS) {
      setCloneError(`That sample is only ${Math.round(secs)}s — at least ${AI33_CLONE_MIN_SECONDS}s is needed.`);
    }
  }, []);

  const startRecording = async () => {
    setCloneError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: Blob[] = [];
      // Prefer mp4/aac over webm/opus: ai33 rejects unknown types and aac
      // is the likelier of the two to be on their allowlist.
      const preferred = ["audio/mp4", "audio/webm"].find(
        (t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t),
      );
      const rec = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recordTimerRef.current) clearInterval(recordTimerRef.current);
        setRecording(false);
        const type = rec.mimeType || preferred || "audio/webm";
        const ext = type.includes("mp4") ? "m4a" : "webm";
        void acceptCloneSample(
          new File([new Blob(chunks, { type })], `recording.${ext}`, { type }),
          recordSecsRef.current,
        );
      };
      recorderRef.current = rec;
      rec.start();
      setRecording(true);
      setRecordSecs(0);
      recordSecsRef.current = 0;
      // Hard stop at the upstream ceiling so a forgotten recording can't
      // produce a sample ai33 will reject. The tick counts in a ref and
      // stops the recorder outside the state updater — updaters run twice
      // under StrictMode, and a second stop() on an inactive recorder
      // throws InvalidStateError.
      recordTimerRef.current = setInterval(() => {
        recordSecsRef.current += 1;
        setRecordSecs(recordSecsRef.current);
        if (recordSecsRef.current >= AI33_CLONE_MAX_SECONDS && recorderRef.current?.state === "recording") {
          recorderRef.current.stop();
        }
      }, 1000);
    } catch {
      setCloneError("Couldn't access the microphone. Choose a file instead.");
    }
  };

  const stopRecording = () => recorderRef.current?.stop();

  useEffect(() => () => {
    if (recordTimerRef.current) clearInterval(recordTimerRef.current);
    recorderRef.current?.stream?.getTracks().forEach((t) => t.stop());
  }, []);

  const submitClone = async () => {
    if (!cloneName.trim() || !cloneFile || !cloneConsent) return;
    setCloneError(null);

    // Over-length is already trimmed at selection; only too-short blocks.
    if (cloneDuration !== null && cloneDuration < AI33_CLONE_MIN_SECONDS) {
      setCloneError(`That sample is only ${Math.round(cloneDuration)}s — at least ${AI33_CLONE_MIN_SECONDS}s is needed.`);
      return;
    }

    setCloning(true);
    try {
      const form = new FormData();
      form.append("name", cloneName.trim());
      form.append("audio", cloneFile);
      const r = await fetch("/api/voices/clone", { method: "POST", body: form });
      const d = await r.json().catch(() => null);
      if (!r.ok) { setCloneError(d?.error ?? "Cloning failed."); return; }
      resetCloneForm();
      setShowCloneForm(false);
      await loadClones();
      if (d?.voice?.voiceId) setSelectedVoice(d.voice.voiceId);
    } catch (e) {
      setCloneError((e as Error).message);
    } finally {
      setCloning(false);
    }
  };

  const deleteClone = async (id: string) => {
    setDeletingClone(id);
    try {
      const r = await fetch(`/api/voices/clone?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!r.ok) {
        const d = await r.json().catch(() => null);
        setCloneError(d?.error ?? "Couldn't delete that voice.");
        return;
      }
      await loadClones();
    } finally {
      setDeletingClone(null);
    }
  };
  // Debounce the Free tab's search box. Resets to page 1 here (not in a
  // separate effect) so a pending page-3 fetch can't fire against the
  // new query first.
  useEffect(() => {
    const t = setTimeout(() => {
      setFreeSearchQuery((prev) => (prev === freeSearch ? prev : freeSearch));
      setFreePage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [freeSearch]);

  // Name the selected ai33 voice when it's not in the static catalog or
  // the loaded page — one lookup per id, cached in state.
  useEffect(() => {
    if (!selectedVoice || !isAi33Voice(selectedVoice)) return;
    if (resolvedFreeVoices[selectedVoice]) return;
    if (AI33_VOICES.some((m) => m.id === selectedVoice)) return;
    if (freeVoices.some((m) => m.id === selectedVoice)) return;
    let cancelled = false;
    fetch(`/api/generate/tts/voices?id=${encodeURIComponent(selectedVoice)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { voice?: KieModel | null } | null) => {
        if (cancelled || !d?.voice) return;
        setResolvedFreeVoices((prev) => ({ ...prev, [selectedVoice]: d.voice! }));
      })
      .catch(() => { /* banner falls back to the id-only label */ });
    return () => { cancelled = true; };
  }, [selectedVoice, freeVoices, resolvedFreeVoices]);

  // Fetch the live free catalog: refetch on gender/search change (page
  // already reset to 1 by the handlers), append on "Load more".
  useEffect(() => {
    // Custom lists the user's own clones from our DB, not ai33's catalog.
    if (voiceTab !== "free" || freeProviderTab === "custom" || FREE_TTS_COMING_SOON) return;
    let cancelled = false;
    setFreeVoicesLoading(true);
    const params = new URLSearchParams({ gender: freeGenderTab, page: String(freePage) });
    if (freeProviderTab !== "all") params.set("provider", freeProviderTab);
    if (freeSearchQuery.trim()) params.set("search", freeSearchQuery.trim());
    // Endpoint unreachable — fall back to the static catalog so the tab
    // still offers voices, scoped to the selected provider to match what
    // the server would have returned.
    const offlineFallback = () => {
      const byGender = ai33VoicesByGender(freeGenderTab === "female" ? "Female" : "Male");
      return freeProviderTab === "all"
        ? byGender
        : byGender.filter((m) => m.id.startsWith(`ai33/${freeProviderTab}_`));
    };
    fetch(`/api/generate/tts/voices?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { voices?: KieModel[]; hasMore?: boolean; live?: boolean } | null) => {
        if (cancelled) return;
        if (!d || !Array.isArray(d.voices)) {
          setFreeLive(false);
          setFreeHasMore(false);
          setFreeVoices(offlineFallback());
          return;
        }
        setFreeLive(d.live !== false);
        setFreeHasMore(!!d.hasMore);
        setFreeVoices((prev) => {
          if (freePage === 1) return d.voices!;
          // Append, keeping ids unique — the catalog repeats a premade
          // block across pages (see listAi33Voices).
          const seen = new Set(prev.map((m) => m.id));
          return [...prev, ...d.voices!.filter((m) => !seen.has(m.id))];
        });
      })
      .catch(() => {
        if (cancelled) return;
        setFreeLive(false);
        setFreeHasMore(false);
        setFreeVoices(offlineFallback());
      })
      .finally(() => { if (!cancelled) setFreeVoicesLoading(false); });
    return () => { cancelled = true; };
  }, [voiceTab, freeProviderTab, freeGenderTab, freeSearchQuery, freePage]);
  const [exportingVoiceover, setExportingVoiceover] = useState(false);
  const [stopped, setStopped] = useState(false);
  // Mirror `stopped` into a ref so the SSE handler (a long-lived async
  // closure) reads the latest value when deciding whether to auto-
  // continue after a batch completes. Reading `stopped` directly would
  // return whatever value was captured when runGeneration() started.
  const stoppedRef = useRef(false);
  useEffect(() => { stoppedRef.current = stopped; }, [stopped]);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);
  const [statusMessage, setStatusMessage] = useState("");
  // AbortController for the in-flight SSE fetch. Stop aborts it; the
  // server detects the closed stream and stops queueing further batches.
  // Any beats already in flight in the current batch will run to
  // completion (their KIE call is already going).
  const abortRef = useRef<AbortController | null>(null);

  function effectiveStatus(b: Beat): BeatStatus {
    const live = liveBeats.get(b.beatNumber);
    if (live) return live.status;
    // If the beat has audio on disk, it's done — regardless of any
    // stale "queued"/"generating" label that may have been left on
    // the row by an older run. This is a safety net for orphaned
    // status writes; the DB cleanup pass in the route handles new
    // runs, but we want existing data to render correctly too.
    if (b.voiceoverUrl) return "done";
    const s = b.voiceoverStatus;
    // "generating" is included so that a browser refresh during a
    // run keeps showing the live status on beats the server is
    // still processing — the function continues server-side past
    // a client disconnect (maxDuration=800), but without this pass-
    // through the page rendered them as "pending" and looked stuck.
    if (s === "queued" || s === "generating" || s === "done" || s === "failed") return s;
    return "pending";
  }

  function effectiveUrl(b: Beat): string | undefined {
    return liveBeats.get(b.beatNumber)?.url ?? b.voiceoverUrl;
  }

  function effectiveError(b: Beat): string | undefined {
    return liveBeats.get(b.beatNumber)?.error ?? b.voiceoverError;
  }

  // A beat is "stale" if it needs regen — same logic the server uses.
  function isStale(b: Beat, voiceId: string | null): boolean {
    if (!b.scriptSegment?.trim()) return false;
    if (!b.voiceoverUrl) return true;
    if (b.voiceoverStatus === "failed" || b.voiceoverStatus === "queued") return true;
    if (voiceId && b.voiceoverVoiceId !== voiceId) return true;
    // Skip script-hash check on the client — the server has the
    // canonical hash; if the script changed we'd see the mismatch
    // via the voiceover_url being from an older render.
    return false;
  }

  const totalBeats = beats.length;
  const doneCount = beats.filter((b) => effectiveStatus(b) === "done").length;
  // Each voiced beat is charged on the characters it spoke, so the balance is
  // stale the moment this moves.
  useEffect(() => {
    if (doneCount > 0) refreshBalance();
  }, [doneCount]);
  const failedCount = beats.filter((b) => effectiveStatus(b) === "failed").length;
  // "Queued" here means a row left in voiceover_status="queued" from a
  // previous run that was cancelled/orphaned — selectStaleBeats picks
  // those up too so they get retried, the user doesn't have to.
  const queuedCount = beats.filter((b) => effectiveStatus(b) === "queued").length;
  const pendingCount = beats.filter((b) => effectiveStatus(b) === "pending").length;
  const staleCount = beats.filter((b) => isStale(b, selectedVoice)).length;
  // "Remaining" = beats that don't yet have a saved voiceover at all.
  // Used for the button label so a partially-complete project doesn't
  // show "Generate {total}" after a refresh — the done beats really do
  // exist on disk, they shouldn't be counted as work the user is about
  // to do. (staleCount can match totalBeats when the picked voice
  // differs from what the done beats were generated with — that's a
  // separate "Regenerate" intent and is signalled in the button text.)
  const remainingCount = beats.filter((b) => !b.voiceoverUrl).length;
  const allDone = totalBeats > 0 && doneCount === totalBeats;

  // The route now loops through all stale beats in one request (the
  // server claims a voiceover_active_run_id and walks the full set
  // server-side), so the client doesn't need to fire follow-up
  // calls between batches anymore. Browser refresh during a run no
  // longer halts the queue.
  // Export the full narration as one MP3. The server ffmpeg-concats every
  // beat's voiceover (cached by ordered-URL hash) and returns its R2 URL.
  // We can't fetch that URL from the browser (cross-origin, no CORS — the
  // "Failed to fetch" the first version hit), so we hand it to our
  // same-origin /download proxy which streams it back with a
  // Content-Disposition attachment header, forcing a real file download.
  async function exportVoiceover() {
    if (exportingVoiceover) return;
    setExportingVoiceover(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/voiceover/concat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({})) as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error ?? "Export failed");

      const downloadUrl = `/api/projects/${projectId}/voiceover/download?url=${encodeURIComponent(data.url)}`;
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.download = "voiceover.mp3";
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast.success("Voiceover exported");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to export voiceover");
    } finally {
      setExportingVoiceover(false);
    }
  }

  async function runGeneration(opts: { beatNumbers?: number[] } = {}) {
    if (!requireVoice()) return;
    if (!totalBeats) { toast.error("No beats — run Prompts step first"); return; }
    if (generating) return;
    setGenerating(true);
    setStopped(false);
    setProgress(null);
    setStatusMessage("Starting…");
    setLiveBeats(new Map());

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    try {
      const res = await fetch("/api/generate/tts/beats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          voiceId: selectedVoice,
          ttsModel,
          ...(opts.beatNumbers ? { beatNumbers: opts.beatNumbers } : {}),
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error("Failed to start voiceover generation");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let receivedTerminal = false;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let ev: { type?: string; message?: string; current?: number; total?: number; beatNumber?: number; status?: BeatStatus; url?: string; error?: string };
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          if (ev.type === "status") setStatusMessage(ev.message ?? "");
          else if (ev.type === "progress") setProgress({ current: ev.current ?? 0, total: ev.total ?? 0 });
          else if (ev.type === "beat" && typeof ev.beatNumber === "number" && ev.status) {
            setLiveBeats((prev) => {
              const next = new Map(prev);
              next.set(ev.beatNumber!, { status: ev.status!, url: ev.url, error: ev.error });
              return next;
            });
          } else if (ev.type === "done") {
            receivedTerminal = true;
            const generated = ev.current ?? 0;
            void generated;
            const total = ev.total ?? 0;
            const remaining = (ev as { remaining?: number }).remaining ?? 0;
            const failedCount = (ev as { failed?: number }).failed ?? 0;
            const wasStopped = (ev as { stopped?: boolean }).stopped === true;
            if (total === 0) toast.success("Voiceovers already up to date");
            else if (wasStopped) {
              // Server-side stop honored. Remaining beats stay as
              // "pending"; user can click Generate again to resume.
              toast.info(`Stopped — ${generated || total - remaining} done, ${remaining} pending.`);
            }
            else if (failedCount > 0) toast.error(`${failedCount} of ${total} failed`);
            else {
              toast.success(`Generated ${total} beat voiceover${total === 1 ? "" : "s"}`);
            }
          } else if (ev.type === "error") {
            receivedTerminal = true;
            throw new Error(ev.message ?? "Generation failed");
          }
        }
      }
      if (!receivedTerminal) throw new Error("Stream ended unexpectedly — try again.");
      await mutate();
    } catch (err) {
      // AbortError fires when the user clicks Stop — that's an
      // intentional cancel, not a failure, so suppress the toast.
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (!isAbort) {
        toast.error(err instanceof Error ? err.message : "Generation failed");
      }
      // "Stream ended unexpectedly" means the SSE connection dropped
      // before the route emitted its terminal event — almost always a
      // Vercel function timeout (800s) or a network blip. In either
      // case the route's `finally` didn't get to clear
      // voiceover_active_run_id, so the UI would keep treating the
      // run as in-flight (via serverGenerationActive) until the
      // 15-minute staleness check expires it. Clear the flag
      // ourselves so the spinner + "Generating" pill go away
      // immediately. The optimistic SWR mutate flips the UI this
      // frame; the PATCH is the durable write.
      const streamEnded = err instanceof Error && err.message.includes("Stream ended unexpectedly");
      if (streamEnded) {
        // Optimistically clear the live overlay for every beat the
        // worker had marked queued or generating — the route's
        // finally never ran, so they're stuck server-side too. The
        // reset-stuck endpoint below fixes the DB; this just gets the
        // UI to flip immediately instead of waiting for SWR.
        setLiveBeats((prev) => {
          const next = new Map(prev);
          for (const [bn, val] of next) {
            if (val.status === "queued" || val.status === "generating") {
              next.delete(bn);
            }
          }
          return next;
        });
        await mutate(
          (cur: Record<string, unknown> | undefined) => cur ? { ...cur, voiceover_active_run_id: null, voiceover_run_started_at: null } : cur,
          { revalidate: false }
        );
        try {
          await fetch(`/api/projects/${projectId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ voiceover_active_run_id: null, voiceover_run_started_at: null }),
          });
        } catch (patchErr) {
          console.warn("[voiceover] failed to clear active_run_id after stream-ended:", patchErr);
        }
        // Reset every per-beat row stuck in queued / generating —
        // these are the orange "Queued" and purple "Generating" pills
        // in the UI that lingered indefinitely otherwise. Done /
        // failed beats are left intact.
        try {
          await fetch("/api/generate/tts/beats/reset-stuck", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId }),
          });
        } catch (resetErr) {
          console.warn("[voiceover] failed to reset stuck beats after stream-ended:", resetErr);
        }
      }
    } finally {
      setGenerating(false);
      setProgress(null);
      setStatusMessage("");
      abortRef.current = null;
      // Clear live overlay so DB-backed state takes over once SWR
      // refreshes — avoids a stale local "done" carrying over after
      // a project change.
      setLiveBeats(new Map());
      await mutate();
    }
  }

  async function stopGeneration() {
    // PATCH the persistent stop flag first so the server's between-
    // batch check picks it up — that's what actually halts a queue
    // running past this client (e.g. across a refresh). Then abort
    // the local SSE stream if one is open so the UI doesn't keep
    // receiving updates for the in-flight batch that's still
    // finishing.
    setStopped(true);
    // Optimistic SWR update — without this, the pill change waits for
    // the PATCH round-trip + the next SWR poll, which felt like the
    // page was stuck until a manual refresh. Mutating the cache with
    // revalidate:false applies the flag locally so React re-renders
    // this frame; the PATCH below is the canonical write, and the
    // mutate() after it does the revalidation.
    await mutate(
      (cur: Record<string, unknown> | undefined) => cur ? { ...cur, voiceover_stop_requested: true } : cur,
      { revalidate: false }
    );
    try {
      await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ voiceover_stop_requested: true }),
      });
      await mutate();
    } catch (err) {
      console.warn("[voiceover] stop PATCH failed:", err);
    }
    abortRef.current?.abort();
  }

  // Server-side generation is "active" when the project's
  // voiceover_active_run_id is set. The TTS beats route claims the
  // run id on entry and clears it on exit (success / stop / error),
  // so this is the canonical "is a run in flight" signal — survives
  // browser refresh and doesn't drift when the server is between
  // batches (when no beat is currently "generating" but the next
  // batch is about to start).
  //
  // Also surface a beat-level count for the in-progress pill so we
  // can say "Processing already in-flight N beats". The worker pool
  // pre-marks the whole stale set as "queued" upfront, so counting
  // queued + generating would inflate this to the entire remaining
  // queue (e.g. "Processing 145 beats" when only 5 are actually in
  // flight). Restrict to "generating" — that's the set the worker
  // pool is actually encoding right now, capped at BATCH_SIZE.
  const projectRunActive = !!(project as { voiceover_active_run_id?: string | null } | undefined)?.voiceover_active_run_id;
  const projectStopRequested = !!(project as { voiceover_stop_requested?: boolean } | undefined)?.voiceover_stop_requested;
  const projectRunStartedAt = (project as { voiceover_run_started_at?: string | null } | undefined)?.voiceover_run_started_at ?? null;
  const inProgressBeatsCount = beats.filter(
    (b) => b.voiceoverStatus === "generating"
  ).length;
  // Vercel kills the TTS route at 800s. When that happens its
  // `finally` block doesn't get to run, so voiceover_active_run_id
  // stays set in the DB and the UI thinks generation is still
  // happening. Detect this by comparing the claim timestamp against
  // a window comfortably past the function timeout — anything older
  // than 15 minutes is a stuck phantom run, not a live one. NULL
  // started_at on a set run_id is treated as stale too (it's the
  // exact pre-migration state of any project that got stuck by this
  // bug), so users can recover without manual DB cleanup.
  const RUN_STALE_AFTER_MS = 15 * 60 * 1000;
  const serverRunIsStale = projectRunActive && (
    !projectRunStartedAt
    || (Date.now() - new Date(projectRunStartedAt).getTime()) > RUN_STALE_AFTER_MS
  );
  const serverGenerationActive = projectRunActive && !serverRunIsStale;
  // Treat the page as "generating" whenever EITHER signal is true.
  // Hides the Generate-remaining button during a server-only run so
  // refreshing mid-generation doesn't make it look like the user has
  // to click again to resume — the route will keep queuing batches
  // server-side and SWR will surface the new state.
  const effectivelyGenerating = generating || serverGenerationActive;

  // Register / release the balance-poll gate. Active while a bulk
  // run is in flight OR any beat is currently mid-generation on the
  // TTS worker (which also covers per-beat regens — those flip the
  // beat row to voiceover_status="generating"). The KieBalanceRow /
  // StepBalanceCard / ElevenLabsBalanceRow subscribe to this signal
  // and pause their /api/api-status polling while the store is
  // empty, so idle-project viewing costs zero KIE and ElevenLabs
  // API calls.
  const markActive = useKieActivityStore((s) => s.markActive);
  const markIdle = useKieActivityStore((s) => s.markIdle);
  useEffect(() => {
    const active = effectivelyGenerating || inProgressBeatsCount > 0;
    if (active) markActive("voiceover");
    else markIdle("voiceover");
    return () => markIdle("voiceover");
  }, [effectivelyGenerating, inProgressBeatsCount, markActive, markIdle]);

  // Per-beat regen is intentionally decoupled from the bulk-run state.
  // It hits the same TTS beats endpoint with skipRunClaim:true so the
  // route doesn't touch voiceover_active_run_id and the page's
  // serverGenerationActive stays false during a single-beat regen.
  // The state below tracks WHICH beat is being regenerated and whether
  // the user has stopped it; the per-beat card uses this to render
  // beat-scoped Stop / Resume controls.
  const [perBeatRegen, setPerBeatRegen] = useState<{ beatNumber: number; status: "running" | "stopped" } | null>(null);
  const perBeatAbortRef = useRef<AbortController | null>(null);

  async function startPerBeatRegen(beatNumber: number) {
    if (!requireVoice()) return;
    setPerBeatRegen({ beatNumber, status: "running" });
    const ctrl = new AbortController();
    perBeatAbortRef.current = ctrl;
    try {
      const res = await fetch("/api/generate/tts/beats", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          voiceId: selectedVoice,
          ttsModel,
          beatNumbers: [beatNumber],
          // Run independently of the bulk-run state.
          skipRunClaim: true,
        }),
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error("Failed to start per-beat regen");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let ev: { type?: string; beatNumber?: number; status?: BeatStatus; url?: string; error?: string };
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          if (ev.type === "beat" && typeof ev.beatNumber === "number" && ev.status) {
            setLiveBeats((prev) => {
              const next = new Map(prev);
              next.set(ev.beatNumber!, { status: ev.status!, url: ev.url, error: ev.error });
              return next;
            });
          } else if (ev.type === "error") {
            throw new Error((ev as { message?: string }).message ?? "Regen failed");
          }
        }
      }
      await mutate();
      // Only clear the regen state if we weren't stopped — a stop
      // transition flips status to "stopped" and shows the Resume
      // button; the run-completion path here is the success case.
      setPerBeatRegen((cur) => (cur && cur.status === "running" ? null : cur));
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      if (!isAbort) {
        toast.error(err instanceof Error ? err.message : "Regen failed");
        setPerBeatRegen(null);
      }
    } finally {
      perBeatAbortRef.current = null;
      // Clear the live overlay for this beat so DB-backed state takes
      // over once SWR refreshes.
      setLiveBeats((prev) => {
        const next = new Map(prev);
        next.delete(beatNumber);
        return next;
      });
    }
  }

  function stopPerBeatRegen() {
    perBeatAbortRef.current?.abort();
    setPerBeatRegen((cur) => (cur ? { ...cur, status: "stopped" } : null));
  }

  function resumePerBeatRegen() {
    if (!perBeatRegen) return;
    void startPerBeatRegen(perBeatRegen.beatNumber);
  }

  // Failed-beat retry is a one-shot fix (no audio to lose), so it runs
  // directly with no confirm. Regenerating a done beat overwrites an
  // existing voiceover and costs KIE credits, so we ask first.
  function retryOne(beatNumber: number, currentStatus: BeatStatus) {
    if (effectivelyGenerating) { toast.error("Wait for the current run to finish"); return; }
    if (perBeatRegen) { toast.error("Another beat is being regenerated"); return; }
    if (currentStatus === "failed") {
      void startPerBeatRegen(beatNumber);
      return;
    }
    setConfirm({
      title: `Regenerate beat ${beatNumber}?`,
      body: (
        <>
          This will overwrite the existing voiceover for beat{" "}
          <span className="font-semibold" style={{ color: "var(--c-80)" }}>#{beatNumber}</span>
          {" "}and re-render it with the selected voice. The current audio for this beat will be replaced.
        </>
      ),
      footnote: onCredits ? "Credits will be charged for this regeneration." : "KIE credits will be charged for this regeneration.",
      icon: "↻",
      iconColor: "oklch(0.72 0.25 285)",
      iconBg: "oklch(0.72 0.25 285 / 0.12)",
      iconBorder: "oklch(0.72 0.25 285 / 0.3)",
      confirmLabel: `Regenerate beat ${beatNumber}`,
      confirmBg: "oklch(0.72 0.25 285)",
      onConfirm: async () => {
        setConfirm(null);
        await startPerBeatRegen(beatNumber);
      },
    });
  }


  const [clearing, setClearing] = useState(false);

  // Single confirm-dialog state: holds either null (closed) or a config
  // object describing the title, body, button copy, and the callback
  // to fire on confirm. Both the Clear and Regenerate-all flows feed
  // into the same modal component below, just with different props.
  type ConfirmConfig = {
    title: string;
    body: React.ReactNode;
    footnote?: string;
    icon: string;
    iconColor: string;
    iconBg: string;
    iconBorder: string;
    confirmLabel: string;
    confirmBg: string;
    onConfirm: () => void | Promise<void>;
    // Alert-style modal: single acknowledge button, no Cancel.
    singleButton?: boolean;
  };
  const [confirm, setConfirm] = useState<ConfirmConfig | null>(null);

  // Guards the generation entry points against a missing or stale voice.
  // selectedVoice can hold a saved id that's no longer in the user's
  // ElevenLabs catalog (e.g. a voice they removed, or an old default) —
  // that isn't null, so a plain !selectedVoice check misses it and the
  // run fails downstream with a cryptic "voice_id … not found". Validate
  // against the live catalog and surface an alert modal instead.
  function requireVoice(): boolean {
    // Free Google voices aren't in the ElevenLabs catalog (ttsModels) — they
    // carry a "google/" prefix and are validated by the backend against the
    // user's connected key, so accept them here without a catalog match.
    const valid = !!selectedVoice && (isQwenVoice(selectedVoice) || isAi33Voice(selectedVoice) || (ttsModels ? ttsModels.some((m) => m.id === selectedVoice) : true));
    if (valid) return true;
    setConfirm({
      title: "Select a voice first",
      body: "Pick a voice from the picker above before generating voiceovers.",
      icon: "!",
      iconColor: "oklch(0.72 0.25 285)",
      iconBg: "oklch(0.72 0.25 285 / 0.12)",
      iconBorder: "oklch(0.72 0.25 285 / 0.3)",
      confirmLabel: "Got it",
      confirmBg: "oklch(0.72 0.25 285)",
      singleButton: true,
      onConfirm: () => setConfirm(null),
    });
    return false;
  }

  async function clearAll() {
    setConfirm(null);
    setClearing(true);
    try {
      const res = await fetch("/api/generate/tts/beats/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? "Clear failed");
      toast.success(`Cleared ${data.cleared ?? 0} beat${data.cleared === 1 ? "" : "s"}`);
      setStopped(false);
      setLiveBeats(new Map());
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Clear failed");
    } finally {
      setClearing(false);
    }
  }

  function openClearConfirm() {
    if (generating || clearing) return;
    if (doneCount === 0) { toast.error("Nothing to clear"); return; }
    setConfirm({
      title: "Clear all voiceovers?",
      body: (
        <>
          Deletes <span className="font-semibold" style={{ color: "var(--c-80)" }}>
            {doneCount} generated voiceover{doneCount === 1 ? "" : "s"}
          </span> from storage and resets every beat to{" "}
          <span className="font-semibold" style={{ color: "var(--c-80)" }}>Pending</span>.
        </>
      ),
      footnote: "This cannot be undone — you'll need to regenerate from scratch.",
      icon: "!",
      iconColor: "oklch(0.7 0.2 25)",
      iconBg: "oklch(0.6 0.22 25 / 0.12)",
      iconBorder: "oklch(0.6 0.22 25 / 0.3)",
      confirmLabel: `Clear ${doneCount} beat${doneCount === 1 ? "" : "s"}`,
      confirmBg: "oklch(0.6 0.22 25)",
      onConfirm: clearAll,
    });
  }

  function openRegenConfirm() {
    if (generating || clearing) return;
    if (!requireVoice()) return;
    if (doneCount === 0) {
      // Nothing on file — Regenerate is just a normal first-time run.
      runGeneration();
      return;
    }
    setConfirm({
      title: "Regenerate all voiceovers?",
      body: (
        <>
          This will overwrite <span className="font-semibold" style={{ color: "var(--c-80)" }}>
            {doneCount} existing voiceover{doneCount === 1 ? "" : "s"}
          </span> and re-render every beat with the selected voice. Your current audio for these beats will be replaced.
        </>
      ),
      footnote: onCredits ? "Credits will be charged for each regenerated beat." : "KIE credits will be charged for each regenerated beat.",
      icon: "↻",
      iconColor: "oklch(0.72 0.25 285)",
      iconBg: "oklch(0.72 0.25 285 / 0.12)",
      iconBorder: "oklch(0.72 0.25 285 / 0.3)",
      confirmLabel: `Regenerate ${totalBeats} beat${totalBeats === 1 ? "" : "s"}`,
      confirmBg: "oklch(0.72 0.25 285)",
      onConfirm: async () => {
        setConfirm(null);
        // Pass every beat number explicitly so selectStaleBeats is
        // bypassed and every beat is re-rendered, regardless of its
        // current done state.
        await runGeneration({ beatNumbers: beats.map((b) => b.beatNumber) });
      },
    });
  }

  // Esc closes the active confirm dialog.
  useEffect(() => {
    if (!confirm) return;
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") setConfirm(null); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm]);

  const hasCustomVoices = useMemo(
    () => (ttsModels ?? []).some((m) => m.tags?.includes("Custom")),
    [ttsModels],
  );
  // The Custom tab's body: the user's own clones, plus the clone form
  // while they're under the cap. Declared here rather than inline so the
  // Free tab's provider/gender branch stays readable.
  // cloneMax is the admin per-plan allocation (Config → Quotas): 0 means
  // cloning isn't part of the plan, -1 means no ceiling.
  const cloneUnlimited = cloneMax < 0;
  // Gated on clonesLoaded: cloneMax starts at 0, so without it every render
  // before the fetch resolves reports "at cap" and flashes the red
  // not-included copy at users who in fact have unlimited.
  const clonesAtCap = clonesLoaded && !cloneUnlimited && clones.length >= cloneMax;

  // Clones live on Heclus's ai33 account but only ever list back to the
  // user who made them.
  const clonePanel = (
    <div className="rounded-xl p-4 space-y-3"
      style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)" }}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] font-semibold" style={{ color: "var(--c-60)" }}>
          Your cloned voices
        </p>
        <span className="text-[10px] tabular-nums" style={{ color: "var(--c-45)" }}>
          {!clonesLoaded ? "…" : cloneUnlimited ? clones.length : `${clones.length}/${cloneMax}`}
        </span>
      </div>

      {/* Panel-level, not inside the form: a load failure leaves cloneMax
          at 0, which hides the form and would hide the reason with it. */}
      {cloneError && (
        <p className="text-[10px]" style={{ color: "oklch(0.7 0.19 25)" }}>{cloneError}</p>
      )}

      {clones.length > 0 && (
        <div className="space-y-1.5">
          {/* Same card as every other voice in the picker, so a clone
              previews and selects identically. previewUrl is the clip it
              was cloned from — ai33 exposes no preview for clones. */}
          {clones.map((c) => (
            <VoiceOption
              key={c.id}
              model={{
                id: c.voiceId,
                name: c.name,
                type: "tts",
                // Always same-origin: the route serves the stored clip when
                // there is one and synthesizes a sample otherwise, so
                // clones made before samples were kept still preview.
                previewUrl: `/api/voices/clone/preview?id=${c.id}`,
              }}
              selected={selectedVoice === c.voiceId}
              onSelect={() => setSelectedVoice(c.voiceId)}
              isPlaying={previewingId === c.voiceId}
              onPlayToggle={setPreviewingId}
              action={
                <button
                  onClick={(e) => { e.stopPropagation(); void deleteClone(c.id); }}
                  disabled={effectivelyGenerating || deletingClone === c.id}
                  title="Delete this cloned voice"
                  aria-label="Delete this cloned voice"
                  className="w-6 h-6 rounded flex items-center justify-center shrink-0 transition-colors disabled:opacity-40"
                  style={{
                    background: "oklch(0.2 0 0)",
                    border: "1px solid var(--bd-10)",
                    color: deletingClone === c.id ? "var(--accent-red-text)" : "var(--c-45)",
                  }}
                >
                  {deletingClone === c.id
                    ? <span className="block w-2.5 h-2.5 border rounded-full animate-spin"
                        style={{ borderColor: "oklch(0.72 0.19 25 / 0.3)", borderTopColor: "oklch(0.72 0.19 25)" }} />
                    : <Trash2 size={11} />}
                </button>
              }
            />
          ))}
        </div>
      )}

      {/* The toggle is always present under the cap, so the form can be
          dismissed as well as opened. Always starts collapsed, empty
          state included. */}
      {clonesAtCap ? (
        // Kept visible but disabled, so the option is discoverable and the
        // reason is stated — rather than the button just vanishing.
        <>
          <button
            disabled
            className="w-full px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1 opacity-40"
            style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)", color: "var(--c-50)" }}
          ><Plus size={12} />Clone a voice</button>
          <p className="text-[10px]" style={{ color: "var(--c-40)" }}>
            {cloneMax > 0
              ? `All ${cloneMax} clone slots used — delete one to make room.`
              : "Voice cloning isn't included on your plan."}
          </p>
        </>
      ) : (
        <>
        {showCloneForm ? (
          // Closing is secondary to filling the form in, so it's a small
          // icon at the right rather than a second full-width button
          // competing with "Clone a voice" at the bottom.
          <div className="flex justify-end">
            <button
              onClick={() => { resetCloneForm(); setShowCloneForm(false); }}
              disabled={cloning}
              aria-expanded
              title="Close"
              aria-label="Close the clone form"
              className="w-6 h-6 rounded flex items-center justify-center transition-colors disabled:opacity-40"
              style={{ background: "oklch(0.2 0 0)", border: "1px solid var(--bd-10)", color: "var(--c-45)" }}
            ><X size={11} /></button>
          </div>
        ) : (
          <button
            onClick={() => setShowCloneForm(true)}
            aria-expanded={false}
            className="w-full px-3 py-1.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1 transition-all"
            style={{
              background: "oklch(0.72 0.25 285 / 0.15)",
              border: "1px solid oklch(0.72 0.25 285 / 0.4)",
              color: "var(--accent-purple-text)",
            }}
          ><Plus size={12} />Clone a voice</button>
        )}
        {showCloneForm && (
        <div className="space-y-2.5">
          <input
            ref={cloneFileInputRef}
            type="file"
            accept="audio/*"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void acceptCloneSample(f); }}
            className="hidden"
          />
          {/* Name/Record/Upload and preview/Clone share one grid, so Clone
              lands exactly under Upload and the preview spans the columns
              above it. Flex with max-widths couldn't guarantee the columns
              lined up.

              On large screens a 1fr spacer column opens up between the name
              and the buttons, pushing them to the right edge; the buttons
              are placed explicitly so nothing flows into the spacer. Narrow
              panels keep the buttons beside the name, where the room is
              needed. */}
          <div className="grid gap-2 items-center grid-cols-[minmax(0,11.5rem)_max-content_max-content] lg:grid-cols-[minmax(0,11.5rem)_1fr_max-content_max-content]">
            <input
              type="text"
              value={cloneName}
              onChange={(e) => setCloneName(e.target.value)}
              placeholder="Voice name"
              disabled={cloning}
              className="w-full px-2.5 py-1.5 rounded-lg text-xs outline-none"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)", color: "var(--c-70)" }}
            />
            <button
              onClick={recording ? stopRecording : startRecording}
              disabled={cloning}
              className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium flex items-center justify-center gap-1.5 transition-all disabled:opacity-40 lg:col-start-3"
              style={recording ? {
                background: "oklch(0.7 0.19 25 / 0.15)",
                border: "1px solid oklch(0.7 0.19 25 / 0.4)",
                color: "var(--accent-red-text)",
              } : {
                background: "var(--bg-panel)",
                border: "1px solid var(--bd-card)",
                color: "var(--c-60)",
              }}
            >{recording
              ? <>Stop · {recordSecs}s</>
              : <><Mic size={11} />Record</>}</button>
            <button
              onClick={() => cloneFileInputRef.current?.click()}
              disabled={cloning || recording}
              className="px-2.5 py-1.5 rounded-lg text-[11px] font-medium flex items-center justify-center gap-1.5 transition-all disabled:opacity-40 lg:col-start-4"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)", color: "var(--c-60)" }}
            ><UploadIcon size={11} />Upload</button>

            {cloneFile && !recording && (
              <>
                <p className="col-span-3 lg:col-span-4 text-[10px] truncate" style={{ color: "var(--c-50)" }}>
                  {cloneFile.name}{cloneDuration !== null && ` · ${Math.round(cloneDuration)}s`}
                  {cloneTrimmed && ` · trimmed to first ${AI33_CLONE_MAX_SECONDS}s`}
                </p>
                {/* Own cell even without a URL, so Clone can't slide into
                    the first column. */}
                <div className="col-span-2 lg:col-span-3 min-w-0">
                  {clonePreviewUrl && (
                    <audio src={clonePreviewUrl} controls className="w-full" style={{ height: "28px" }} />
                  )}
                </div>
                <button
                  onClick={submitClone}
                  disabled={cloning || !cloneName.trim() || !cloneFile || !cloneConsent}
                  className="px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-all disabled:opacity-40 lg:col-start-4"
                  style={{
                    background: "oklch(0.72 0.25 285 / 0.15)",
                    border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                    color: "var(--accent-purple-text)",
                  }}
                >{cloning ? "Cloning…" : "Clone"}</button>
              </>
            )}
          </div>
          <label className="flex items-start gap-1.5 text-[10px] leading-snug" style={{ color: "var(--c-45)" }}>
            <input
              type="checkbox"
              checked={cloneConsent}
              onChange={(e) => setCloneConsent(e.target.checked)}
              disabled={cloning}
              className="mt-0.5 shrink-0"
            />
            <span>I have the speaker&apos;s permission to clone this voice.</span>
          </label>
          {/* A greyed-out button with no reason is a dead end. Recording
              only satisfies one of three requirements, so show all three
              rather than naming one at a time. */}
          {cloning ? (
            <p className="text-[10px]" style={{ color: "var(--c-40)" }}>Uploading your sample to clone…</p>
          ) : (
            <div className="space-y-1">
              {([
                ["Sample recorded or chosen", !!cloneFile],
                ["Voice named", !!cloneName.trim()],
                ["Permission confirmed", cloneConsent],
              ] as const).map(([label, done]) => (
                <p key={label} className="text-[10px] flex items-center gap-1"
                  style={{ color: done ? "var(--accent-green-text)" : "var(--c-40)" }}>
                  <span>{done ? "✓" : "○"}</span>{label}
                </p>
              ))}
            </div>
          )}
          <p className="text-[10px]" style={{ color: "var(--c-40)" }}>
            At least {AI33_CLONE_MIN_SECONDS}s of clean speech. Longer samples are trimmed to {AI33_CLONE_MAX_SECONDS}s.
          </p>
        </div>
        )}
        </>
      )}
    </div>
  );

  // Search within the active tab — matches voice name and tag text.
  // Cleared on tab switch so a leftover query never makes a fresh tab
  // look mysteriously empty.
  const [voiceSearch, setVoiceSearch] = useState("");
  const filteredVoices = useMemo(
    // Custom tab: everything the user added/cloned to their
    // ElevenLabs account (tagged by listTTSVoices), regardless of
    // gender. Gender tabs: non-custom voices matching the tab —
    // Neutral-tagged catalog voices show under BOTH gender tabs so
    // they're never invisible.
    () => {
      const inTab = (ttsModels ?? []).filter((m) => {
        const isCustom = m.tags?.includes("Custom");
        if (voiceTab === "custom") return isCustom;
        // Free tab renders a "coming soon" placeholder, not a voice grid,
        // so nothing needs to match here.
        if (voiceTab === "free") return false;
        if (isCustom) return false;
        const tag = m.tags?.[0]?.toLowerCase();
        return tag === voiceTab || tag === "neutral";
      });
      const q = voiceSearch.trim().toLowerCase();
      if (!q) return inTab;
      return inTab.filter((m) =>
        m.name.toLowerCase().includes(q) || (m.tags ?? []).some((t) => t.toLowerCase().includes(q)),
      );
    },
    [ttsModels, voiceTab, voiceSearch],
  );

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "var(--bg-page-2)" }}>
      <WizardNav projectId={projectId} currentState={9} highestState={project?.current_state} channelName={project?.channel_name} channelUrl={project?.channel_url} />

      <main className="flex-1 flex flex-col overflow-hidden pt-[92px] md:pt-0 lg:px-[15px]">
        {/* Header */}
        <div className="shrink-0 px-5 sm:px-8 py-4 sm:py-5"
          style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}>
          <div>
            <h1 className="font-bold text-base sm:text-lg">Voiceover</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              One narration clip per beat. Each beat&apos;s clip is the timing source for its visual — no matcher, no drift.
            </p>
            <div className="mt-3 flex items-center gap-2 flex-wrap min-w-0 w-full">
              <StepCostCard projectId={projectId} column="voiceover" />
              <StepBalanceCard />
              <CostTipsModal />
              {/* Free resources button hidden until the /free-resources
                  page is built. Drop this back in when ready:
                  <FreeResourcesButton step="voiceover" /> */}
            </div>
          </div>
        </div>

        <div ref={scrollContainerRef} className="flex-1 overflow-y-auto pb-[70px] relative">
        <div className="px-5 py-4 sm:p-8 pb-24 space-y-8">

          {/* Voice picker */}
          <div className="rounded-2xl p-5" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
            <div className="flex items-center justify-between mb-3">
              <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>
                Voice
              </p>
              {voiceTab !== "free" && !!ttsModels?.length && (
                <span className="text-[11px] font-mono tabular-nums" style={{ color: "var(--c-45)" }}>
                  {ttsModels.length} voices · {filteredVoices.length} {voiceTab}
                </span>
              )}
            </div>
            {/* Paid / Free decide the catalog; Female / Male / Custom are
                sub-pills of Paid, mirroring how Free nests its own
                provider and gender pills. Custom only renders when the
                user's ElevenLabs account has added/cloned voices. */}
            <div className="space-y-1.5 mb-4">
              <div className="flex gap-1">
                {([
                  { group: "paid", active: voiceTab !== "free" },
                  { group: "free", active: voiceTab === "free" },
                ] as const).map(({ group, active }) => (
                  <button
                    key={group}
                    onClick={() => {
                      setVoiceTab(group === "free"
                        ? "free"
                        : (lastPaidTab === "custom" && !hasCustomVoices ? "female" : lastPaidTab));
                      setVoiceSearch("");
                    }}
                    disabled={effectivelyGenerating}
                    className="flex-1 px-2 py-2 rounded-lg text-xs font-semibold capitalize transition-all disabled:opacity-40"
                    style={active ? {
                      background: "oklch(0.72 0.25 285 / 0.15)",
                      border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                      color: "var(--accent-purple-text)",
                    } : {
                      background: "var(--bg-input)",
                      border: "1px solid var(--bd-card)",
                      color: "var(--c-50)",
                    }}
                  >{group === "free" && FREE_TTS_COMING_SOON ? (
                    <span className="flex flex-col items-center leading-tight">
                      <span>😄 Free</span>
                      <span className="text-[9px] font-semibold normal-case">coming soon</span>
                    </span>
                  ) : group === "free" ? "😄 Free" : group}</button>
                ))}
              </div>
              {voiceTab !== "free" && (
                <>
                <p className="text-[10px] font-semibold" style={{ color: "var(--c-40)" }}>
                  ElevenLabs
                </p>
                {/* Which model speaks, not which voice. The same voice on
                    Multilingual v2 and on Turbo is recognisably the same person
                    reading differently, and one of them bills at twice the
                    rate — so the price sits on the button rather than in a
                    tooltip nobody opens. Only shown for ElevenLabs voices; the
                    free tab is a different provider that ignores this. */}
                <div className="flex gap-1 flex-wrap">
                  {TTS_MODELS.map((m) => {
                    const on = ttsModel === m.id;
                    return (
                      <button
                        key={m.id}
                        onClick={() => chooseTtsModel(m.id)}
                        disabled={effectivelyGenerating}
                        title={`${m.note} — ${ttsCreditsPerKChars(m.perKChars)} credits per 1,000 characters ($${m.perKChars.toFixed(2)} at list)`}
                        className="px-2.5 py-1 rounded-lg text-[11px] font-medium transition-all disabled:opacity-40"
                        style={on ? {
                          background: "oklch(0.72 0.25 285 / 0.15)",
                          border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                          color: "var(--accent-purple-text)",
                        } : {
                          background: "var(--bg-input)",
                          border: "1px solid var(--bd-card)",
                          color: "var(--c-50)",
                        }}
                      >
                        <span className="flex flex-col items-center leading-tight">
                          <span>{m.label}</span>
                          {/* Credits, because that is what the wallet spends
                              and what every other price in the product is
                              quoted in. The dollar figure is the provider's
                              list rate and lives on the hover. */}
                          <span className="text-[9px] font-normal" style={{ opacity: 0.75 }}>
                            {ttsCreditsPerKChars(m.perKChars)} cr / 1k chars
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="flex gap-1 flex-wrap">
                  {([...(["female", "male"] as const), ...(hasCustomVoices ? (["custom"] as const) : [])]).map((tab) => (
                    <button
                      key={tab}
                      onClick={() => { setVoiceTab(tab); setLastPaidTab(tab); setVoiceSearch(""); }}
                      disabled={effectivelyGenerating}
                      className="px-2.5 py-1 rounded-lg text-[11px] font-medium capitalize transition-all disabled:opacity-40"
                      style={voiceTab === tab ? {
                        background: "oklch(0.72 0.25 285 / 0.15)",
                        border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                        color: "var(--accent-purple-text)",
                      } : {
                        background: "var(--bg-input)",
                        border: "1px solid var(--bd-card)",
                        color: "var(--c-50)",
                      }}
                    >{tab === "custom" ? (
                      <span className="flex flex-col items-center leading-tight">
                        <span>Custom</span>
                        <span className="text-[9px] font-normal normal-case" style={{ opacity: 0.7 }}>
                          cloned · generated · professional
                        </span>
                      </span>
                    ) : tab}</button>
                  ))}
                </div>
                </>
              )}
            </div>
            {voiceTab === "free" ? (
              FREE_TTS_COMING_SOON ? (
                // TEMPORARY (lib/free-tier-flag.ts): free voiceover paused.
                <div className="rounded-xl px-4 py-8 text-center"
                  style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)" }}>
                  <p className="text-base font-bold" style={{ color: "var(--primary)" }}>
                    Great Good News!
                  </p>
                  <p className="text-sm font-medium mt-2" style={{ color: "var(--c-70)" }}>
                    Thank you for choosing us and for being part of our journey.
                  </p>
                  <p className="text-xs mt-1.5 leading-relaxed" style={{ color: "var(--c-45)" }}>
                    We&apos;re building free resources to help you streamline your
                    production, reduce costs, and achieve more with less. Stay with us
                    as we continue to grow into the one-stop solution you&apos;ve been
                    looking for.
                  </p>
                </div>
              ) : (
              // Free voiceover = the ai33 perk only. Runs on HECLUS's own
              // ai33 token, capped per user per month, no setup needed.
              <div className="scroll-themed space-y-5 max-h-[26rem] overflow-y-auto pr-1">
                {freeTtsUsage && freeTtsUsage.ai33TtsCap <= 0 ? (
                  // Plan gate: cap 0 = the admin allocated this plan no ai33
                  // quota. Any plan can be set to 0, so don't name one.
                  <div className="rounded-xl px-4 py-5 text-center"
                    style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)" }}>
                    <p className="text-sm font-medium" style={{ color: "var(--c-70)" }}>
                      Free voices aren&apos;t included in your plan
                    </p>
                    <p className="text-xs mt-1.5" style={{ color: "var(--c-45)" }}>
                      Pick a paid voice, or upgrade your plan.
                    </p>
                  </div>
                ) : (
                <div className="space-y-4">
                  <FreeQuotaBar
                    badge="Heclus perks 🎁"
                    badgeNote="You use, we pay"
                    used={freeTtsUsage?.ai33TtsChars ?? 0}
                    cap={freeTtsUsage?.ai33TtsCap ?? 0}
                    loaded={!!freeTtsUsage}
                  />
                  {/* Clone slots are part of the same perk allowance, so
                      they belong next to the character bar rather than
                      only inside the Custom tab. */}
                  <div className="flex items-center justify-between gap-2 text-[10px]">
                    <span style={{ color: "var(--c-45)" }}>Custom voice clones</span>
                    <span className="tabular-nums" style={{ color: clonesAtCap ? "var(--accent-red-text)" : "var(--c-45)" }}>
                      {!clonesLoaded
                        ? "…"
                        : cloneUnlimited
                          ? `${clones.length} used · unlimited`
                          : cloneMax > 0
                            ? `${clones.length} / ${cloneMax} used`
                            : "not included on your plan"}
                    </span>
                  </div>
                  {/* Provider + gender/custom pills are one filter group,
                      kept tight so they read as a unit against the quota bar
                      above and the voice list below. */}
                  <div className="space-y-1.5">
                  {/* Provider subtabs, one level above the gender split.
                      "All" merges every provider in catalog order; the
                      rest narrow to a single vendor. Custom sits here too:
                      a clone is its own ai33 provider, not a gender.
                      flex-wrap so the pills don't squeeze on a narrow
                      panel. */}
                  <div className="flex gap-1 flex-wrap">
                    {([
                      { id: "all", label: "All" },
                      ...AI33_FREE_PROVIDERS,
                      { id: "custom", label: "Cloned voices", pro: true },
                    ] as const).map((p) => (
                      <button
                        key={p.id}
                        onClick={() => { setFreeProviderTab(p.id); setFreePage(1); }}
                        disabled={effectivelyGenerating}
                        className="px-2.5 py-1 rounded-lg text-[11px] font-medium inline-flex items-center gap-1 transition-all disabled:opacity-40"
                        style={freeProviderTab === p.id ? {
                          background: "oklch(0.72 0.25 285 / 0.15)",
                          border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                          color: "var(--accent-purple-text)",
                        } : {
                          background: "var(--bg-input)",
                          border: "1px solid var(--bd-card)",
                          color: "var(--c-50)",
                        }}
                      >{p.label}{"pro" in p && p.pro && (
                        <span className="px-1 rounded text-[9px] font-bold uppercase tracking-wide"
                          style={{ background: "oklch(0.75 0.15 85 / 0.18)", color: "var(--accent-amber-text)" }}>
                          pro
                        </span>
                      )}</button>
                    ))}
                  </div>
                  {/* Female / Male narrows whatever the provider row above
                      selected, so it's indented under it rather than
                      reading as a second sibling filter. Switching resets
                      to page 1: the gender is a server-side filter, not a
                      client-side split of one loaded list. Custom has no
                      gender split — those are the user's own voices. */}
                  {freeProviderTab !== "custom" && (
                  <div className="flex gap-1 flex-wrap items-center pl-2.5 ml-0.5"
                    style={{ borderLeft: "1px solid var(--bd-card)" }}>
                    <span className="text-[10px]" style={{ color: "var(--c-40)" }}>
                      {freeProviderTab === "all"
                        ? "All providers"
                        : AI33_FREE_PROVIDERS.find((p) => p.id === freeProviderTab)?.label}
                    </span>
                    {(["female", "male"] as const).map((g) => (
                      <button
                        key={g}
                        onClick={() => { setFreeGenderTab(g); setFreePage(1); }}
                        disabled={effectivelyGenerating}
                        className="px-2.5 py-1 rounded-lg text-[11px] font-medium capitalize transition-all disabled:opacity-40"
                        style={freeGenderTab === g ? {
                          background: "oklch(0.72 0.25 285 / 0.15)",
                          border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                          color: "var(--accent-purple-text)",
                        } : {
                          background: "var(--bg-input)",
                          border: "1px solid var(--bd-card)",
                          color: "var(--c-50)",
                        }}
                      >{g}</button>
                    ))}
                  </div>
                  )}
                  </div>
                  {freeProviderTab === "custom" ? (
                    clonesLoaded && cloneMax === 0 ? (
                      <div className="rounded-xl px-4 py-5 text-center"
                        style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)" }}>
                        <p className="text-sm font-medium" style={{ color: "var(--c-70)" }}>
                          This feature is available to only pro users
                        </p>
                        <p className="text-xs mt-1.5" style={{ color: "var(--c-45)" }}>
                          Upgrade to Pro to clone your own voice.
                        </p>
                        <button
                          onClick={() => setShowUpgradeModal(true)}
                          className="mt-3 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all"
                          style={{
                            background: "oklch(0.72 0.25 285 / 0.15)",
                            border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                            color: "var(--accent-purple-text)",
                          }}
                        >Upgrade to Pro</button>
                      </div>
                    ) : clonePanel
                  ) : (
                  <>
                  {/* Search runs server-side against the whole catalog
                      (name + description), not just the loaded page. */}
                  <input
                    type="search"
                    value={freeSearch}
                    onChange={(e) => setFreeSearch(e.target.value)}
                    placeholder="Search free voices — name, accent, style…"
                    aria-label="Search free voices"
                    className="w-full px-2.5 py-1.5 rounded-lg text-xs outline-none transition-colors"
                    style={{
                      background: "var(--bg-input)",
                      border: "1px solid oklch(0.72 0.25 285 / 0.3)",
                      color: "var(--c-70)",
                    }}
                  />
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] tabular-nums" style={{ color: "var(--c-45)" }}>
                      {freeVoices.length > 0 && `${freeVoices.length} loaded`}
                    </span>
                    {!freeLive && (
                      <span className="text-[10px]" style={{ color: "var(--c-45)" }}>
                        Live catalog unreachable — showing the built-in set
                      </span>
                    )}
                  </div>
                  {freeVoicesLoading && freeVoices.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-10 gap-2">
                      <span className="block w-6 h-6 border-2 rounded-full animate-spin"
                        style={{ borderColor: "oklch(0.72 0.25 285 / 0.3)", borderTopColor: "oklch(0.72 0.25 285)" }} />
                      <p className="text-xs" style={{ color: "var(--c-40)" }}>Loading voices…</p>
                    </div>
                  ) : freeVoices.length === 0 ? (
                    <p className="text-xs text-center py-6" style={{ color: "var(--c-40)" }}>
                      {(() => {
                        const providerLabel = AI33_FREE_PROVIDERS.find((p) => p.id === freeProviderTab)?.label;
                        if (freeSearchQuery.trim()) {
                          return `No ${providerLabel ?? "free"} voices match “${freeSearchQuery.trim()}”`;
                        }
                        return providerLabel
                          ? `No ${providerLabel} voices available right now`
                          : "No free voices available right now";
                      })()}
                    </p>
                  ) : (
                    <>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {freeVoices.map((m) => (
                          <VoiceOption
                            key={m.id}
                            model={m}
                            selected={selectedVoice === m.id}
                            onSelect={() => setSelectedVoice(m.id)}
                            isPlaying={previewingId === m.id}
                            onPlayToggle={setPreviewingId}
                          />
                        ))}
                      </div>
                      {freeHasMore && (
                        <button
                          onClick={() => setFreePage((p) => p + 1)}
                          disabled={freeVoicesLoading}
                          className="w-full px-3 py-2 rounded-lg text-xs font-medium transition-all disabled:opacity-50"
                          style={{
                            background: "var(--bg-input)",
                            border: "1px solid oklch(0.72 0.25 285 / 0.3)",
                            color: "var(--accent-purple-text)",
                          }}
                        >
                          {freeVoicesLoading ? "Loading…" : "Load more voices"}
                        </button>
                      )}
                    </>
                  )}
                  </>
                  )}
                </div>
                )}
              </div>
              )
            ) : (
            <>
            {/* Search — spans the full width across all tabs; filters the
                active tab's voices by name or tag. */}
            <input
              type="search"
              value={voiceSearch}
              onChange={(e) => setVoiceSearch(e.target.value)}
              placeholder={`Search ${voiceTab} voices…`}
              aria-label="Search voices"
              className="w-full px-2.5 py-1.5 rounded-lg text-xs outline-none transition-colors mb-3"
              style={{
                background: "var(--bg-input)",
                border: "1px solid oklch(0.72 0.25 285 / 0.3)",
                color: "var(--c-70)",
              }}
            />
            {voiceSearch.trim() && filteredVoices.length === 0 && (
              <p className="text-xs text-center py-4" style={{ color: "var(--c-40)" }}>
                No voices match &ldquo;{voiceSearch.trim()}&rdquo;
              </p>
            )}
            <div className="scroll-themed grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-60 overflow-y-auto pr-1">
              {(!ttsModels || project === undefined) ? (
                // Single page-load indicator — keeps the rest of the
                // page calm while voices + project data are fetched.
                // The grid below replaces this once both land.
                <div className="col-span-full flex flex-col items-center justify-center py-10 gap-2">
                  <span className="block w-6 h-6 border-2 rounded-full animate-spin"
                    style={{ borderColor: "oklch(0.72 0.25 285 / 0.3)", borderTopColor: "oklch(0.72 0.25 285)" }} />
                  <p className="text-xs" style={{ color: "var(--c-40)" }}>Loading…</p>
                </div>
              ) : (
                <>
                  {filteredVoices.length === 0 && (
                    <p className="text-xs px-1" style={{ color: "var(--c-40)" }}>No {voiceTab} voices available</p>
                  )}
                  {filteredVoices.map((m) => (
                    <VoiceOption
                      key={m.id}
                      model={m}
                      selected={selectedVoice === m.id}
                      onSelect={() => setSelectedVoice(m.id)}
                      isPlaying={previewingId === m.id}
                      onPlayToggle={setPreviewingId}
                    />
                  ))}
                </>
              )}
            </div>
            </>
            )}
          </div>

          {project === undefined ? null : (
          <>
          {/* Bulk action panel */}
          <div ref={bulkPanelRef} className="rounded-2xl p-5 space-y-3" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
            {/* Selected-voice banner — sits above the count/action row
                so the user always sees which voice the next batch will
                use, right next to the beats list (the most relevant
                context). Resolves the saved id against the live models
                catalog so the name (e.g. "Bella · female") shows
                instead of the opaque id. */}
            {(() => {
              // Resolve the name from the ElevenLabs catalog OR the free
              // Google catalog so a selected free voice shows its name too.
              // freeVoices (the live ai33 page currently loaded) comes
              // before the static AI33_VOICES — most live ai33 voices
              // aren't in the static list at all.
              const model = selectedVoice
                ? (ttsModels?.find((m) => m.id === selectedVoice) ?? freeVoices.find((m) => m.id === selectedVoice) ?? resolvedFreeVoices[selectedVoice] ?? QWEN_VOICES.find((m) => m.id === selectedVoice) ?? AI33_VOICES.find((m) => m.id === selectedVoice))
                : null;
              const tag = model?.tags?.[0];
              return (
                <div
                  className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl"
                  style={{ background: "oklch(0.72 0.25 285 / 0.08)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}
                  title={selectedVoice ? `Voice id: ${selectedVoice}` : undefined}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[10px] uppercase tracking-wider font-semibold shrink-0" style={{ color: "var(--accent-purple-text)" }}>
                      Voice
                    </span>
                    <span className="text-sm font-semibold truncate" style={{ color: "var(--accent-purple-text)" }}>
                      {model?.name ?? (selectedVoice
                        // An ai33 id that hasn't resolved yet is a known
                        // free voice, not an unknown one — the lookup is
                        // one request behind, so don't cry wolf.
                        ? (isAi33Voice(selectedVoice) ? "Free voice" : ttsModels ? "Unknown voice" : "Loading…")
                        : "None selected")}
                    </span>
                    {tag && (
                      <span className="text-xs capitalize shrink-0" style={{ color: "color-mix(in oklch, var(--accent-purple-text) 85%, transparent)" }}>
                        · {tag}
                      </span>
                    )}
                  </div>
                </div>
              );
            })()}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div className="min-w-0">
                <p className="font-semibold text-sm">
                  {totalBeats === 0 ? "No beats yet" : allDone ? "All beats ready" : `${doneCount} of ${totalBeats} beats done`}
                </p>
                <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
                  {totalBeats === 0 ? (
                    "Run the Prompts step first."
                  ) : (
                    <>
                      {/* Explicit breakdown: surface every category so the
                          user can see what's already on file vs what the
                          next click will touch. Categories with zero
                          beats are dropped to keep the line short. */}
                      {[
                        doneCount > 0 && `${doneCount} done`,
                        failedCount > 0 && `${failedCount} failed`,
                        queuedCount > 0 && `${queuedCount} queued`,
                        pendingCount > 0 && `${pendingCount} pending`,
                      ].filter(Boolean).join(" · ")}
                      {staleCount > 0 && doneCount > 0 && (
                        <> · <span style={{ color: "oklch(0.6 0.15 145)" }}>{doneCount} already done will be kept</span></>
                      )}
                    </>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0 flex-wrap">
                {/* Clear: wipes every beat's voiceover from R2 + DB.
                    Disabled while a run is in flight (would race with
                    in-flight writes) or when there's nothing to delete. */}
                <button
                  onClick={openClearConfirm}
                  disabled={effectivelyGenerating || clearing || doneCount === 0}
                  title={doneCount === 0
                    ? "No generated voiceovers to clear"
                    : `Deletes all ${doneCount} generated voiceover${doneCount === 1 ? "" : "s"} from storage and resets every beat to Pending`}
                  className="px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-40 transition-all"
                  style={{
                    background: "transparent",
                    color: "oklch(0.7 0.2 25)",
                    border: "1px solid oklch(0.6 0.22 25 / 0.4)",
                  }}
                >
                  {clearing ? "Clearing…" : "Clear"}
                </button>
                {/* Stop button only shows while the local SSE stream
                    is alive AND Stop hasn't been requested yet. The
                    moment Stop is clicked, projectStopRequested goes
                    true (optimistic SWR update) and this branch falls
                    through to the serverGenerationActive pill below —
                    which now reads "Processing already queued N
                    beats". No wait for the fetch's finally block. */}
                {generating && !projectStopRequested ? (
                  <button
                    onClick={stopGeneration}
                    title="Stop after the current batch finishes"
                    className="px-4 py-2 rounded-lg text-sm font-semibold transition-all"
                    style={{ background: "oklch(0.6 0.22 25)", color: "var(--bg-page-2)" }}
                  >
                    <span className="flex items-center gap-2">
                      <span className="w-3.5 h-3.5 rounded-sm" style={{ background: "currentColor" }} />
                      Stop
                    </span>
                  </button>
                ) : serverGenerationActive ? (
                  // Hoisted above the stopped/Resume branch so a
                  // server-side run that's still winding down (post-
                  // Stop or post-refresh) always wins over the local
                  // "Resume N" fallback. Once the run id clears, this
                  // falls through to the Resume / Generate branches.
                  <div className="flex items-center gap-2">
                    <div
                      className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs"
                      title={projectStopRequested
                        ? "Stop received — no new beats will start, but the worker pool's in-flight KIE calls will still finish."
                        : "Voiceover generation is running on the server. The page will update as each beat completes."}
                      style={{ background: "oklch(0.72 0.25 285 / 0.1)", border: "1px solid oklch(0.72 0.25 285 / 0.3)", color: "var(--accent-purple-text)" }}
                    >
                      <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                      <span className="font-medium">
                        {projectStopRequested
                          ? `Finishing ${inProgressBeatsCount} in-flight beat${inProgressBeatsCount === 1 ? "" : "s"}`
                          : "Generating…"}
                      </span>
                    </div>
                    {!projectStopRequested && (
                      <button
                        onClick={stopGeneration}
                        title="Stop after the current batch finishes"
                        className="px-4 py-2 rounded-lg text-sm font-semibold transition-all"
                        style={{ background: "oklch(0.6 0.22 25)", color: "var(--bg-page-2)" }}
                      >
                        <span className="flex items-center gap-2">
                          <span className="w-3.5 h-3.5 rounded-sm" style={{ background: "currentColor" }} />
                          Stop
                        </span>
                      </button>
                    )}
                  </div>
                ) : stopped && staleCount > 0 ? (
                  <button
                    onClick={() => runGeneration()}
                    disabled={!totalBeats || !selectedVoice}
                    title={`Resumes voiceover generation for the remaining ${staleCount} beat${staleCount === 1 ? "" : "s"}`}
                    className="px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 transition-all"
                    style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                  >
                    {`Resume ${staleCount} beat${staleCount === 1 ? "" : "s"}`}
                  </button>
                ) : (() => {
                  // Three button modes:
                  //   1. Some beats missing audio + some already done → "Generate remaining N beats"
                  //      (server's selectStaleBeats will still pick up
                  //       voice-mismatched done beats too, but the user-
                  //       facing count reflects only the truly missing
                  //       work so a 50/100 refresh doesn't read as a
                  //       full restart.)
                  //   2. All beats missing audio (fresh run) → "Generate N beats"
                  //   3. All beats have audio but staleCount > 0 (voice / script
                  //      changed since generation) → "Regenerate N beats"
                  //   4. Nothing stale at all → "Regenerate all" (opens the confirm)
                  const mode =
                    staleCount === 0 ? "regen-all" :
                    remainingCount > 0 && doneCount > 0 ? "remaining" :
                    remainingCount > 0 ? "fresh" :
                    "stale-regen";
                  const label =
                    mode === "regen-all" ? "Regenerate all" :
                    mode === "remaining" ? `Generate remaining ${remainingCount} beat${remainingCount === 1 ? "" : "s"}` :
                    mode === "fresh" ? `Generate ${remainingCount} beat${remainingCount === 1 ? "" : "s"}` :
                    /* stale-regen */ `Regenerate ${staleCount} beat${staleCount === 1 ? "" : "s"}`;
                  const titleText =
                    mode === "regen-all" ? `Re-runs TTS for all ${totalBeats} beats — overwrites every existing voiceover` :
                    mode === "remaining" ? `Generates ${remainingCount} beat${remainingCount === 1 ? "" : "s"} that don't have audio yet; ${doneCount} already-done beat${doneCount === 1 ? "" : "s"} kept` :
                    mode === "fresh" ? `Generates ${remainingCount} beat${remainingCount === 1 ? "" : "s"}` :
                    `Re-runs TTS for ${staleCount} beat${staleCount === 1 ? "" : "s"} where the voice or script changed since generation`;
                  return (
                    <button
                      onClick={mode === "regen-all" ? openRegenConfirm : () => runGeneration()}
                      disabled={!totalBeats || !selectedVoice}
                      title={titleText}
                      className="px-4 py-2 rounded-lg text-sm font-semibold disabled:opacity-40 transition-all"
                      style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                    >
                      {label}
                    </button>
                  );
                })()}
              </div>
            </div>
            {generating && progress && progress.total > 0 && (
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-[11px]" style={{ color: "var(--c-45)" }}>
                  <span className="font-mono tabular-nums">{progress.current}/{progress.total}</span>
                  <span>completed</span>
                </div>
                <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--bg-progress)" }}>
                  <div className="h-full rounded-full transition-all duration-200"
                    style={{ width: `${Math.round((progress.current / progress.total) * 100)}%`, background: "oklch(0.55 0.15 145)" }} />
                </div>
              </div>
            )}

            {/* Per-beat cards — 2-column grid, kept inside the same
                bordered section as the voice summary + actions above. */}
            {beats.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-4" style={{ borderTop: "1px solid var(--bd-6)" }}>
              {beats.map((b) => {
                const status = effectiveStatus(b);
                const url = effectiveUrl(b);
                const err = effectiveError(b);
                // Card style varies by state so the user can see at a
                // glance which beats are already on file (subtle green
                // accent) vs which need work (default panel for pending
                // / queued, red accent for failed).
                const cardStyle =
                  status === "done"
                    ? { background: "oklch(0.55 0.15 145 / 0.06)", border: "1px solid oklch(0.55 0.15 145 / 0.25)" }
                    : status === "failed"
                      ? { background: "oklch(0.6 0.22 25 / 0.06)", border: "1px solid oklch(0.6 0.22 25 / 0.3)" }
                      : { background: "var(--bg-panel)", border: "1px solid var(--bd-card)" };
                return (
                  <div
                    key={b.beatNumber}
                    className="rounded-xl p-4 flex items-start gap-3"
                    style={cardStyle}
                  >
                    <span
                      className="font-mono text-xs font-semibold tabular-nums shrink-0 w-7"
                      style={{ color: "var(--c-45)" }}
                    >
                      {b.beatNumber}
                    </span>
                    <div className="flex-1 min-w-0 space-y-1.5">
                      <p
                        className="text-xs leading-relaxed line-clamp-3"
                        style={{ color: "var(--c-60)" }}
                      >
                        {b.scriptSegment}
                      </p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <StatusPill status={status} />
                      </div>
                      {status === "done" && url && (
                        // preload="metadata" loads just the audio
                        // header (duration etc.) so the player UI
                        // populates the moment the beat flips to
                        // "done", without waiting for the user to
                        // click play. preload="none" left the
                        // player blank until interaction, which
                        // looked broken during a live SSE run.
                        // key={url} re-mounts the element if R2
                        // ever hands back a new URL for the same
                        // beat (e.g. regen), so the audio src
                        // never stays stale on the old file.
                        <BeatAudioPlayer key={url} src={url} beatNumber={b.beatNumber} />
                      )}
                      {status === "failed" && err && (
                        <span
                          className="text-[10px] block"
                          style={{ color: "oklch(0.7 0.2 25)" }}
                          title={err}
                        >
                          {err.length > 80 ? err.slice(0, 80) + "…" : err}
                        </span>
                      )}
                    </div>
                    {(() => {
                      const isPerBeatRegen = perBeatRegen?.beatNumber === b.beatNumber;
                      // Per-beat regen state takes priority on this
                      // row — show Stop while running, Resume after
                      // the user stopped it.
                      if (isPerBeatRegen && perBeatRegen?.status === "running") {
                        return (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span
                              className="w-7 h-7 rounded-lg flex items-center justify-center"
                              aria-label="Beat regenerating"
                              title="Regenerating"
                              style={{ background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.3)", color: "var(--brand-text)" }}
                            >
                              <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                            </span>
                            <button
                              onClick={stopPerBeatRegen}
                              aria-label="Stop regenerating this beat"
                              title="Stop"
                              className="w-7 h-7 rounded-lg flex items-center justify-center text-[11px] font-medium transition-opacity hover:opacity-90"
                              style={{ background: "oklch(0.6 0.22 25)", color: "var(--bg-page-2)" }}
                            >
                              <span className="w-3 h-3 rounded-sm" style={{ background: "currentColor" }} />
                            </button>
                          </div>
                        );
                      }
                      if (isPerBeatRegen && perBeatRegen?.status === "stopped") {
                        return (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              onClick={resumePerBeatRegen}
                              aria-label="Resume regenerating this beat"
                              title="Resume"
                              className="px-2.5 py-1 rounded-lg text-[11px] font-medium transition-opacity hover:opacity-90"
                              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                            >
                              Resume
                            </button>
                            <button
                              onClick={() => setPerBeatRegen(null)}
                              aria-label="Dismiss"
                              title="Dismiss"
                              className="w-7 h-7 rounded-lg flex items-center justify-center text-[11px] font-medium transition-opacity hover:opacity-90"
                              style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-card)", color: "var(--c-55)" }}
                            >
                              ×
                            </button>
                          </div>
                        );
                      }
                      // No per-beat regen for this row. Render either
                      // a spinner (bulk run actively encoding this beat)
                      // or a static dot (beat is waiting in the queue,
                      // worker pool hasn't picked it up yet). Pre-worker-
                      // pool, "queued" was a transient state for ~5
                      // rows at a time, so a spinner read fine; now the
                      // queue can span hundreds of rows and a spinner
                      // on every one would falsely suggest 100+ beats
                      // are in flight simultaneously.
                      if (status === "generating") {
                        return (
                          <div
                            className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                            aria-label="Beat regenerating"
                            title="Regenerating"
                            style={{ background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.3)", color: "var(--brand-text)" }}
                          >
                            <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin" />
                          </div>
                        );
                      }
                      if (status === "queued") {
                        return (
                          <div
                            className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0"
                            aria-label="Beat queued"
                            title="Queued"
                            style={{ background: "oklch(0.72 0.16 70 / 0.10)", border: "1px solid oklch(0.72 0.16 70 / 0.28)", color: "var(--accent-amber-text)" }}
                          >
                            <span className="w-2 h-2 rounded-full" style={{ background: "currentColor", opacity: 0.75 }} />
                          </div>
                        );
                      }
                      if ((status === "failed" || status === "done") && !generating) {
                        return (
                          <button
                            onClick={() => retryOne(b.beatNumber, status)}
                            aria-label={status === "failed" ? "Retry beat" : "Regenerate beat"}
                            title={status === "failed" ? "Retry" : "Regenerate"}
                            className={`${status === "failed" ? "px-2.5" : "px-1.5"} py-1 rounded-lg text-[11px] font-medium flex items-center justify-center transition-opacity hover:opacity-90 shrink-0`}
                            style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-card)", color: "var(--c-55)" }}
                          >
                            {status === "failed" ? "Retry" : <RotateCw className="w-3.5 h-3.5" />}
                          </button>
                        );
                      }
                      return null;
                    })()}
                  </div>
                );
              })}
            </div>
          )}
          </div>

          {/* Full voiceover preview — sits below the beat grid so the
              user reviews each beat individually first, then hears the
              whole narration end-to-end. Renders as soon as ANY beat
              has audio (live overlay or persisted) so the user can
              start listening before the full run finishes. Plays the
              per-beat mp3s in order client-side — no server concat
              (that stays on the assemble page where the trim-silence
              A/B compare genuinely needs ffmpeg). */}
          {(beats.some((b) => !!b.voiceoverUrl)
            || Array.from(liveBeats.values()).some((s) => s.status === "done" && !!s.url)) && (
            <>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>
                  Full voiceover
                </span>
                {/* Export the whole narration as a single MP3. Server
                    ffmpeg-concats every beat's voiceover (cached by hash),
                    then we download the returned file. */}
                <button
                  type="button"
                  onClick={exportVoiceover}
                  disabled={exportingVoiceover}
                  title="Download the full voiceover as one MP3 file"
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
                  style={{ background: "oklch(0.72 0.25 285 / 0.12)", color: "var(--brand-text)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}
                >
                  {exportingVoiceover ? (
                    <>
                      <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      Exporting…
                    </>
                  ) : (
                    <>
                      <Download size={13} />
                      Export audio
                    </>
                  )}
                </button>
              </div>
              <SequentialVoiceoverPreview beats={beats} liveBeats={liveBeats} />
            </>
          )}
          </>
          )}
        </div>
        </div>
      </main>

      {/* Jump-to-top / jump-to-bottom — floating purple chevrons in
          the right-edge corners of the page area. Mirrors the same
          affordance on the Generate step. Only renders when there's
          at least one beat (otherwise the buttons would scroll an
          empty container). Up sits clear of the page header; Down
          sits above the Help bubble and the Continue bar. */}
      {beats.length > 0 && (
        <>
          <button
            type="button"
            onClick={() => bulkPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
            title="Jump to the bulk action panel"
            aria-label="Scroll to bulk action panel"
            className="fixed top-24 right-5 z-30 w-7 h-7 rounded-md flex items-center justify-center transition-all hover:scale-105 active:scale-95"
            style={{ background: "oklch(0.72 0.25 285)", color: "white", boxShadow: "0 2px 8px oklch(0.72 0.25 285 / 0.45)" }}
          >
            <ChevronUp size={14} />
          </button>
          <button
            type="button"
            onClick={() => scrollContainerRef.current?.scrollTo({ top: scrollContainerRef.current.scrollHeight, behavior: "smooth" })}
            title="Jump to the last beat"
            aria-label="Scroll to bottom"
            className="fixed bottom-24 right-5 z-30 w-7 h-7 rounded-md flex items-center justify-center transition-all hover:scale-105 active:scale-95"
            style={{ background: "oklch(0.72 0.25 285)", color: "white", boxShadow: "0 2px 8px oklch(0.72 0.25 285 / 0.45)" }}
          >
            <ChevronDown size={14} />
          </button>
        </>
      )}

      {/* Continue bar — shows as soon as at least one beat has audio
          so the user can advance without waiting for the whole batch.
          Wording softens to "Continue with N of M" until allDone, then
          becomes the plain "Continue →" once everything's ready. */}
      {doneCount > 0 && (
        <div
          className="fixed bottom-0 left-0 md:left-64 right-0 z-20 py-3"
          style={{ background: "var(--bg-header-2)", borderTop: "1px solid var(--bd-6)", backdropFilter: "blur(12px)" }}
        >
          <div className="sm:px-8">
            <button
              onClick={() => router.push(`/projects/${projectId}/generate`)}
              className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
            >
              {allDone ? "Continue →" : `Continue with ${doneCount} of ${totalBeats} beats →`}
            </button>
          </div>
        </div>
      )}

      {/* Confirm dialog — driven by the `confirm` state. Both the Clear
          and Regenerate-all flows reuse this same shell, just with
          different copy, icon, and confirm-button color. */}
      {confirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: "oklch(0 0 0 / 0.6)", backdropFilter: "blur(4px)" }}
          onClick={() => setConfirm(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl p-6 space-y-4"
            style={{ background: "var(--bg-card)", border: "1px solid var(--bd-card)" }}
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-modal-title"
          >
            <div className="flex items-start gap-3">
              <div
                className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                style={{ background: confirm.iconBg, border: `1px solid ${confirm.iconBorder}` }}
              >
                <span style={{ color: confirm.iconColor, fontSize: "20px", lineHeight: 1 }}>{confirm.icon}</span>
              </div>
              <div className="flex-1 min-w-0">
                <h2 id="confirm-modal-title" className="text-base font-bold" style={{ color: "var(--c-90)" }}>
                  {confirm.title}
                </h2>
                <p className="text-sm mt-1" style={{ color: "var(--c-50)" }}>
                  {confirm.body}
                </p>
                {confirm.footnote && (
                  <p className="text-xs mt-2" style={{ color: "var(--c-45)" }}>
                    {confirm.footnote}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              {!confirm.singleButton && (
                <button
                  onClick={() => setConfirm(null)}
                  className="px-4 py-2 rounded-lg text-sm font-medium transition-opacity hover:opacity-80"
                  style={{ background: "transparent", color: "var(--c-60)", border: "1px solid var(--bd-card)" }}
                >
                  Cancel
                </button>
              )}
              <button
                onClick={() => { void confirm.onConfirm(); }}
                autoFocus
                className="px-4 py-2 rounded-lg text-sm font-semibold transition-opacity hover:opacity-90"
                style={{ background: confirm.confirmBg, color: "var(--bg-page-2)" }}
              >
                {confirm.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      )}

      {showUpgradeModal && (
        <SubscriptionModal
          email={userEmail}
          defaultPlan="pro"
          hideTryDemo
          onClose={() => setShowUpgradeModal(false)}
          onSuccess={() => setShowUpgradeModal(false)}
        />
      )}
    </div>
  );
}
