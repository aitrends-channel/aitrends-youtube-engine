"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { WizardNav } from "@/components/wizard/WizardNav";
import { StepCostCard } from "@/components/StepCostCard";
import { StepBalanceCard } from "@/components/StepBalanceCard";
import { useProject } from "@/hooks/useProject";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import type { Beat } from "@/lib/types";
import { FullVoiceoverPreview } from "@/components/voiceover/FullVoiceoverPreview";
import { presignedUpload } from "@/lib/upload-client";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { SubscriptionModal } from "@/components/SubscriptionModal";
import { PRO_RESOLUTIONS, PRO_TIER_PLANS } from "@/lib/plans-gating";
import { isAdminUser } from "@/lib/admin";

interface PageProps {
  params: { projectId: string };
}

const ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:5", "4:3", "3:4", "21:9"] as const;
type AspectRatio = typeof ASPECT_RATIOS[number];

// Pro-tier resolution gate constants live in lib/plans-gating so the
// UI here and the assemble POST endpoint share one source of truth.

const RESOLUTION_PRESETS = ["720p", "1080p", "1440p", "2160p"] as const;
type ResolutionPreset = typeof RESOLUTION_PRESETS[number];

// Per-preset short/long edge sizes. Vertical (9:16) uses short as
// width, square uses short on both axes, horizontal uses long×short.
// Matches the dimsFor() implementation server-side.
const RESOLUTION_EDGES: Record<ResolutionPreset, { long: number; short: number }> = {
  "720p":  { long: 1280, short: 720 },
  "1080p": { long: 1920, short: 1080 },
  "1440p": { long: 2560, short: 1440 },
  "2160p": { long: 3840, short: 2160 },
};

// Generic aspect-ratio → pixel dims. The resolution preset's `short`
// edge is held constant (so "1080p" is 1080 on the short side for any
// ratio — 1920×1080 landscape, 1080×1920 portrait, 1080×1080 square,
// matching platform conventions); the long edge is derived from the
// ratio and rounded to even (ffmpeg requires even dimensions).
function dimsFor(aspect: AspectRatio, preset: ResolutionPreset): { w: number; h: number; label: string } {
  const { long, short } = RESOLUTION_EDGES[preset];
  const [wr, hr] = aspect.split(":").map(Number);
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  let w: number, h: number;
  if (!wr || !hr) { w = long; h = short; }                 // malformed → 16:9
  else if (wr === hr) { w = short; h = short; }            // square
  else if (wr > hr) { h = short; w = even((short * wr) / hr); }  // landscape
  else { w = short; h = even((short * hr) / wr); }         // portrait
  return { w, h, label: `${w} × ${h}` };
}

const CAPTION_LANGUAGES = [
  { code: "source", label: "Source language" },
  { code: "Spanish", label: "Spanish" },
  { code: "French", label: "French" },
  { code: "Portuguese", label: "Portuguese" },
  { code: "German", label: "German" },
  { code: "Italian", label: "Italian" },
  { code: "Japanese", label: "Japanese" },
  { code: "Korean", label: "Korean" },
  { code: "Chinese", label: "Chinese" },
  { code: "Hindi", label: "Hindi" },
  { code: "Arabic", label: "Arabic" },
] as const;

const CAPTION_STYLES = [
  { id: "classic", label: "Classic", hint: "White, black outline" },
  { id: "bold",    label: "Bold",    hint: "Yellow, bold" },
  { id: "boxed",   label: "Boxed",   hint: "White on dark box" },
  { id: "minimal", label: "Minimal", hint: "White, thin outline" },
] as const;

const CAPTION_SIZES     = [{ id: "small", label: "S" }, { id: "medium", label: "M" }, { id: "large", label: "L" }] as const;
const CAPTION_POSITIONS = [{ id: "bottom", label: "Bottom" }, { id: "top", label: "Top" }] as const;

export default function AssemblePage({ params }: PageProps) {
  const { projectId } = params;
  const router = useRouter();
  const { project, mutate } = useProject(projectId);

  const beats: Beat[] = project?.beats ?? [];
  const ttsUrl: string | null = project?.tts_url ?? null;
  const ttsCleanedUrl: string | null = project?.tts_cleaned_url ?? null;
  const generatedVideos = beats.filter((b) => b.videoUrl).length;
  const videoBeats = beats.filter((b) => b.videoPrompt).length;

  // Bump current_state to 15 the first time the user lands here so the
  // Generate step ticks done in the WizardNav. No-op on subsequent visits.
  useEffect(() => {
    const reached = project?.current_state as number | undefined;
    if (reached !== undefined && reached < 15) {
      fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current_state: 15 }),
      }).then(() => mutate()).catch(() => { /* non-blocking */ });
    }
  }, [project?.current_state, projectId, mutate]);


  // Hydrate BGM, logo, trim-silence, and the five caption knobs from
  // the project row on first load. Migrations 047 (BGM + logo) and 051
  // (trim + captions) backed these columns; /api/generate/assemble
  // writes them when the user clicks Assemble. The ref guard runs this
  // exactly once per mount so later SWR polls don't clobber in-
  // progress local edits (e.g. a slider tweak mid-session). NULL on
  // any column means the project pre-dates that migration or never
  // assembled — fall through to the React-side default in that case.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (!project || hydratedRef.current) return;
    hydratedRef.current = true;
    const bgmUrl = project.background_music_url as string | null | undefined;
    if (bgmUrl) {
      setBgmUploadedUrl(bgmUrl);
      const v = project.background_music_volume;
      if (typeof v === "number") setBgmVolume(v);
    }
    const lUrl = project.logo_url as string | null | undefined;
    if (lUrl) {
      setLogoUploadedUrl(lUrl);
      const x = project.logo_x, y = project.logo_y, s = project.logo_size;
      if (typeof x === "number") setLogoX(x);
      if (typeof y === "number") setLogoY(y);
      if (typeof s === "number") setLogoSize(s);
    }
    // Default the output aspect ratio to the project's actual video
    // ratio so the logo-placement preview (and the render) match the
    // clips instead of always assuming 16:9. The user can still override
    // it with the selector.
    const projAspect = (project as { video_aspect_ratio?: string | null }).video_aspect_ratio;
    if (typeof projAspect === "string" && (ASPECT_RATIOS as readonly string[]).includes(projAspect)) {
      setAspectRatio(projAspect as AspectRatio);
    }
    const trim = (project as { trim_silence_enabled?: boolean | null }).trim_silence_enabled;
    if (typeof trim === "boolean") setTrimSilence(trim);
    const cap = project as {
      captions_enabled?:  boolean | null;
      captions_language?: string  | null;
      captions_style?:    string  | null;
      captions_size?:     string  | null;
      captions_position?: string  | null;
    };
    if (typeof cap.captions_enabled  === "boolean") setCaptionsEnabled(cap.captions_enabled);
    if (typeof cap.captions_language === "string" && cap.captions_language) setCaptionsLanguage(cap.captions_language);
    if (typeof cap.captions_style    === "string" && cap.captions_style)    setCaptionsStyle(cap.captions_style);
    if (typeof cap.captions_size     === "string" && cap.captions_size)     setCaptionsSize(cap.captions_size);
    if (typeof cap.captions_position === "string" && cap.captions_position) setCaptionsPosition(cap.captions_position);
  }, [project]);

  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
  // Render resolution. Default 1080p (matches YouTube's HD standard
  // and the dimensions previously displayed in the Output card).
  const [selectedResolution, setSelectedResolution] = useState<ResolutionPreset>("1080p");

  // Pro-tier gate for 1440p / 2160p. We look up app_metadata.plan
  // once on mount via the browser Supabase client — same pattern as
  // the dashboard. Defaults to "starter" so the UI gates Pro-only
  // presets while the fetch is in flight; if the user actually has
  // Pro the buttons flip enabled within a tick. Admins bypass.
  const [userPlan, setUserPlan] = useState<string>("starter");
  const [userEmail, setUserEmail] = useState<string>("");
  // Drives the SubscriptionModal when a non-Pro user clicks a
  // Pro-locked resolution. SubscriptionModal is mounted lazily —
  // most assemble sessions never need it.
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  useEffect(() => {
    let cancelled = false;
    const client = createSupabaseBrowserClient();
    client.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      const meta = (data.user?.app_metadata ?? {}) as { plan?: unknown };
      // isAdminUser folds in both the app_metadata.is_admin flag AND
      // the legacy hardcoded ADMIN_EMAILS backstop — otherwise the
      // founder admin (recognised by email) would fail canUsePro and
      // get locked out of 4K assemble.
      if (isAdminUser(data.user)) {
        setUserPlan("admin");
      } else if (typeof meta.plan === "string" && meta.plan.trim()) {
        setUserPlan(meta.plan.trim().toLowerCase());
      }
      if (data.user?.email) setUserEmail(data.user.email);
    }).catch(() => { /* leave default */ });
    return () => { cancelled = true; };
  }, []);
  const canUsePro = PRO_TIER_PLANS.has(userPlan);
  // Per-preview loading state — true while either A/B card is still
  // building on the server or buffering audio in the browser. Drives
  // the "Loading previews…" indicator under the Voiceover Source label.
  // Default true so the indicator paints from first render whenever
  // there are voiceovers to preview, instead of flickering on after
  // the child cards mount and report back.
  const [trimmedLoading, setTrimmedLoading] = useState(true);
  const [originalLoading, setOriginalLoading] = useState(true);

  // Per-beat silence trim — drives the worker's trimSilenceEnabled flag.
  // Outgoing requests hard-code voiceoverType to "original" so the
  // worker's legacy-mode source-mp3 picker (tts_url ?? tts_cleaned_url)
  // prefers the freshest voiceover. Defaulting to "cleaned" silently
  // resurrected stale tts_cleaned_url files from the old "Trim to
  // video length" flow — users heard a voiceover they didn't recognize.
  // In per-beat mode (current default) voiceoverType is ignored anyway.
  const [trimSilence, setTrimSilence] = useState<boolean>(true);
  // Optional background music. The file gets uploaded to storage on
  // first assemble (via /api/upload) and the resulting public URL is
  // sent to the worker. backgroundMusicVolume is a 0–1 multiplier the
  // worker applies in ffmpeg's amix filter — 0.15 is the classic
  // "podcast bed" level that keeps voiceover crisp.
  const [bgmFile, setBgmFile] = useState<File | null>(null);
  const [bgmUploadedUrl, setBgmUploadedUrl] = useState<string | null>(null);
  const [bgmVolume, setBgmVolume] = useState<number>(0.15);
  // Inline preview playback for the uploaded/selected background music.
  const bgmAudioRef = useRef<HTMLAudioElement | null>(null);
  const [bgmPlaying, setBgmPlaying] = useState(false);
  const [bgmUploading, setBgmUploading] = useState(false);
  const bgmInputRef = useRef<HTMLInputElement>(null);
  // Channel logo overlay. logoX/logoY are top-left position as a
  // fraction of video dimensions (0–1); logoSize is logo width as a
  // fraction of video width. Same upload model as bgm — local file →
  // blob URL for the drag preview, then uploaded to storage on
  // assemble. Defaults put the logo in the top-right corner at 10%
  // width (classic YouTube watermark placement).
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [logoUploadedUrl, setLogoUploadedUrl] = useState<string | null>(null);
  const [logoObjectUrl, setLogoObjectUrl] = useState<string | null>(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoX, setLogoX] = useState<number>(0.85);
  const [logoY, setLogoY] = useState<number>(0.05);
  const [logoSize, setLogoSize] = useState<number>(0.1);
  const logoInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!logoFile) {
      if (logoObjectUrl) URL.revokeObjectURL(logoObjectUrl);
      setLogoObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(logoFile);
    setLogoObjectUrl(url);
    return () => { URL.revokeObjectURL(url); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logoFile]);

  // Local blob URL for in-browser preview playback. Created when a
  // file is picked and revoked when it's replaced or cleared so we
  // don't leak object URLs over the page's lifetime.
  const [bgmObjectUrl, setBgmObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!bgmFile) {
      if (bgmObjectUrl) URL.revokeObjectURL(bgmObjectUrl);
      setBgmObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(bgmFile);
    setBgmObjectUrl(url);
    return () => { URL.revokeObjectURL(url); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgmFile]);
  const [captionsEnabled, setCaptionsEnabled] = useState(false);
  const [captionsLanguage, setCaptionsLanguage] = useState("source");
  const [captionsStyle, setCaptionsStyle] = useState("classic");
  const [captionsSize, setCaptionsSize] = useState("medium");
  const [captionsPosition, setCaptionsPosition] = useState("bottom");

  // Live-persist trim + captions to the project row whenever they
  // change. The /api/generate/assemble call already writes them on
  // Assemble, but a user who toggles "Original voiceover" or flips
  // captions to "bold/large/top" and then refreshes without clicking
  // Assemble would lose their selection. Debounced so a rapid
  // sequence of dropdown changes coalesces into one PATCH instead
  // of spamming the API. Skipped on first render — hydratedRef
  // gates this so we don't PATCH the hydrated values straight back
  // to the server.
  useEffect(() => {
    if (!hydratedRef.current) return;
    const t = setTimeout(() => {
      void fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          trim_silence_enabled: trimSilence,
          captions_enabled: captionsEnabled,
          captions_language: captionsLanguage,
          captions_style: captionsStyle,
          captions_size: captionsSize,
          captions_position: captionsPosition,
        }),
      }).catch(() => { /* non-blocking — Assemble click is the safety net */ });
    }, 500);
    return () => clearTimeout(t);
  }, [trimSilence, captionsEnabled, captionsLanguage, captionsStyle, captionsSize, captionsPosition, projectId]);
  const [assembling, setAssembling] = useState(false);
  // Monotonic high-water mark for the rendered stage index. We hold
  // the latest matched stage so a transient unmatched status line
  // from the worker doesn't drop the visible step back to 1 before
  // the next valid line snaps it forward (the cause of the visible
  // "reverses then continues" jump). Reset to -1 whenever assembling
  // flips back on (a new run, or a Resume that may revisit earlier
  // stages — both want the watermark to restart from scratch).
  const lastStageIdxRef = useRef<number>(-1);
  useEffect(() => {
    if (assembling) lastStageIdxRef.current = -1;
  }, [assembling]);
  // True from the moment the user clicks Stop until the worker
  // acknowledges by transitioning assembly_status to "stopped".
  // Lets the button label/disabled-state flip to "Stopping…"
  // instantly while the worker finishes its current ffmpeg stage and
  // persists the checkpoint.
  const stopRequested = !!project?.assembly_stop_requested;
  const finalizeRequested = !!project?.assembly_finalize_preview_requested;
  // Confirm dialog for Reassemble. Reassemble doesn't start the run
  // directly anymore — it asks first, then on confirm flips the page
  // into reassembleMode, which hides the current assembled video and
  // reveals the pre-assembly config panel so the user can pick a
  // different voiceover, change captions, etc. before kicking off.
  const [reassembleConfirmOpen, setReassembleConfirmOpen] = useState(false);
  const [bgmDisclaimerOpen, setBgmDisclaimerOpen] = useState(false);
  // When true: the existing assembled video is suppressed and the
  // config + Assemble button block is rendered. Cleared automatically
  // when assembleVideo() actually fires (the new run will replace
  // project.assembled_url on success) or if the user navigates away
  // and comes back.
  const [reassembleMode, setReassembleMode] = useState(false);
  const [assembleStatus, setAssembleStatus] = useState("");
  const [assembledUrl, setAssembledUrl] = useState<string | null>(null);

  // Derived: the URL we should actually show in the preview. Single
  // source of truth for "is the preview section visible". Hidden
  // whenever:
  //   - the user committed to reassembling (don't flash the deleted
  //     video back even for a tick), or
  //   - a new assembly is in flight (assembling status), or
  //   - the DB row carries no assembled_url (the canonical source —
  //     the moment clear_assembled lands, the preview disappears).
  // Local `assembledUrl` state is no longer consulted for the gate;
  // the polling effects keep it for unrelated UI bits (e.g. the
  // download anchor target) but rendering decisions go through here
  // so a stale local value can't flash an already-deleted player.
  const dbAssembledUrl = (project?.assembled_url as string | undefined) ?? null;
  const previewUrl: string | null = (reassembleMode || assembling) ? null : dbAssembledUrl;
  const showPreview = !!previewUrl;

  // Width the preview <video> actually renders at: min(panel width,
  // 70vh × ratio) — the same bound its max-h-[70vh] + max-w-full impose.
  // The action buttons use this so they line up with the video's width
  // instead of spilling full-width under a narrow portrait preview.
  const [arW, arH] = aspectRatio.split(":").map(Number);
  const previewMaxW = arW && arH ? `min(100%, calc(70vh * ${arW} / ${arH}))` : "100%";

  // In-progress preview — the worker uploads mixed.mp4 (full audio +
  // visuals at intermediate resolution, no captions/logo yet) as soon
  // as the mix step lands, BEFORE the multi-minute final-burn pass.
  // On the >80-beat path that burn can take 10-25 min; this gives
  // the user something watchable while they wait. Only shown while
  // assembly is still in progress; cleared by the worker on every
  // terminal transition.
  const inProgressPreviewUrl: string | null =
    assembling && !reassembleMode
      ? ((project?.assembly_preview_url as string | undefined) ?? null)
      : null;

  // Inline preview-load error. The <video> element fires onError
  // when the src URL is unreachable (worker temp file vanished, R2
  // 404, etc.). We don't toast (it was popping every first page load
  // for stale R2 URLs and felt like a hard error); we set this flag
  // so an inline note appears under the player. onLoadedMetadata
  // clears the flag, so a transient buffering hiccup that recovers
  // doesn't leave the warning stuck.
  const [previewLoadError, setPreviewLoadError] = useState(false);
  useEffect(() => { setPreviewLoadError(false); }, [previewUrl]);

  useEffect(() => {
    // Don't auto-restore the preview URL while the user is actively
    // reassembling — the SWR cache can still have stale project data
    // for a tick or two between the PATCH that nulled assembled_url and
    // the refetch that picks up the change, and this effect would
    // otherwise flash the old video back in.
    if (reassembleMode) return;
    const status = project?.assembly_status as string | undefined;
    const url = project?.assembled_url as string | undefined;
    if (!assembling && url && !assembledUrl && (status === "done" || status === "preview")) {
      setAssembledUrl(url);
    }
  }, [project, assembling, assembledUrl, reassembleMode]);

  useEffect(() => {
    const status = project?.assembly_status as string | undefined;
    if (!status) return;
    if (status === "queued") {
      setAssembling(true);
      setAssembleStatus("Queued…");
    } else if (status === "processing" || status === "uploading") {
      setAssembling(true);
      setAssembleStatus((project?.assembly_progress as string | undefined) ?? "Assembling…");
    } else if (status === "stopped") {
      // Worker honored the Stop signal and persisted the checkpoint.
      // Keep the panel visible so the user sees the Resume button
      // (rendered below) without having to refresh — the panel renders
      // as long as `assembling` is true, and `assembleStatus` carries
      // the last progress line so they remember where it stopped.
      setAssembling(true);
      setAssembleStatus((project?.assembly_progress as string | undefined) ?? "Stopped — click Resume to continue");
    } else if (status === "preview" || status === "done") {
      // Loading-state clears always run on terminal success — leaving
      // `assembling` true after status=done left the progress panel
      // stuck on screen with no way for the user to dismiss it.
      // The reassembleMode guard now only gates re-populating
      // assembledUrl (the original concern was that stale "done"
      // status from the SWR cache pre-refetch would otherwise put
      // the deleted URL back). Clearing the loading flag is safe
      // either way: if the user is mid-reassemble flow they're
      // looking at the config panel, not the progress strip.
      const url = project?.assembled_url as string | undefined;
      setAssembling(false);
      setAssembleStatus("");
      if (!reassembleMode && url) setAssembledUrl(url);
    } else if (status === "failed") {
      if (assembling) toast.error((project?.assembly_error as string | undefined) ?? "Assembly failed");
      setAssembling(false);
      setAssembleStatus("");
      setAssembledUrl((prev) => (prev?.includes("/api/preview/") ? null : prev));
    }
  }, [project?.assembly_status, project?.assembly_progress, reassembleMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Confirm-Reassemble action. Hits the clear_assembled endpoint which
  // deletes the assembled mp4 from R2, wipes the assembly_* fields on
  // the project (including the saved checkpoint), then flips the page
  // into reassembleMode so the user can adjust voiceover / captions /
  // aspect ratio before kicking off the new run. The old video is
  // gone the moment this resolves — there is no fallback to the
  // previous output.
  //
  // Order matters: we flip every local-state gate that could keep the
  // preview visible BEFORE the network round-trip. Otherwise the user
  // sees the old player for the ~500ms the PATCH + SWR refetch takes,
  // which looks like the button didn't work. The PATCH itself is then
  // the canonical cleanup (DB + R2), and the mutate() that follows
  // syncs project.assembled_url back to null so the gate stays closed
  // even when reassembleMode eventually drops back to false.
  const [clearingAssembled, setClearingAssembled] = useState(false);
  async function confirmReassemble() {
    // Hide preview + reset every local cache that could keep it
    // visible. These run before the network call so the player
    // disappears immediately on click.
    setReassembleMode(true);
    setAssembledUrl(null);
    setAssembleStatus("");
    setReassembleConfirmOpen(false);
    // Optimistic SWR update: blank assembled_url + assembly_* fields
    // locally so the gate reads null immediately, even before the
    // PATCH completes and the canonical refetch lands.
    void mutate((cur: Record<string, unknown> | undefined) => cur ? {
      ...cur,
      assembled_url: null,
      assembly_status: null,
      assembly_progress: null,
      assembly_error: null,
      assembly_checkpoint: null,
    } : cur, { revalidate: false });
    setClearingAssembled(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear_assembled: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to clear assembled video");
      }
      // Canonical refetch — replaces the optimistic state with the
      // server's truth. If the PATCH failed mid-flight, this is what
      // would surface the inconsistency.
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not clear the existing video");
      // Roll back the optimistic hide so the user can see the existing
      // video again and retry, instead of being stuck on a config
      // panel that doesn't reflect actual server state.
      setReassembleMode(false);
      await mutate();
    } finally {
      setClearingAssembled(false);
    }
  }

  async function stopAssembly() {
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assembly_stop_requested: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to request stop");
      }
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Stop failed");
    }
  }

  // Step 1 of the two-step "ship the preview" flow.
  // PATCHes the finalize-preview flag; the worker watches it
  // alongside assembly_stop_requested and aborts to a stopped state
  // with the flag preserved. The UI then shows a Continue button
  // (in place of Resume) which calls commitPreview() to actually
  // promote the preview to assembled_url.
  async function finalizeWithPreview() {
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assembly_finalize_preview_requested: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to request finalize");
      }
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Finalize failed");
    }
  }

  // Step 2 of the two-step flow. Called from the Continue button on
  // the stopped panel. Promotes assembly_preview_url to assembled_url
  // and flips the project to done — no worker round-trip needed
  // since mixed.mp4 is already in R2.
  const [committingPreview, setCommittingPreview] = useState(false);
  async function commitPreview() {
    setCommittingPreview(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ commit_preview: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to commit preview");
      }
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not use this preview");
    } finally {
      setCommittingPreview(false);
    }
  }

  // Confirm-Cancel action paired with Resume when assembly_status is
  // "stopped". Hits the cancel_assembly PATCH which wipes the
  // checkpoint folder + every assembly_* field on the project (but
  // leaves assembled_url alone so a previously-successful video stays
  // available). After this the progress panel goes away and the user
  // is back at the pre-assembly config view.
  const [cancelAssemblyConfirmOpen, setCancelAssemblyConfirmOpen] = useState(false);
  const [cancellingAssembly, setCancellingAssembly] = useState(false);
  async function cancelAssembly() {
    setCancellingAssembly(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cancel_assembly: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to cancel");
      }
      setAssembling(false);
      setAssembleStatus("");
      setCancelAssemblyConfirmOpen(false);
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Cancel failed");
    } finally {
      setCancellingAssembly(false);
    }
  }

  async function resumeAssembly() {
    try {
      // Re-queue via the same endpoint as a fresh assembly. The endpoint
      // writes the current options into Redis (so the worker reads the
      // user's CURRENT settings on Resume — captionsStyle changes etc.
      // take effect) and clears assembly_stop_requested. The worker's
      // checkpoint-hash check then invalidates only the suffix of stages
      // affected by any changed options.
      const res = await fetch("/api/generate/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          aspectRatio,
          voiceoverType: "original",
          captionsEnabled,
          captionsLanguage,
          captionsStyle,
          captionsSize,
          captionsPosition,
          trimSilenceEnabled: trimSilence,
          backgroundMusicUrl: bgmUploadedUrl,
          backgroundMusicVolume: bgmVolume,
          resolution: selectedResolution,
          logoUrl: logoUploadedUrl,
          logoX, logoY, logoSize,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to resume");
      }
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Resume failed");
    }
  }

  // Upload the picked BGM file once and cache its URL on this page
  // for the lifetime of the file selection. Re-uploads only when the
  // user picks a different file. Returns null on no-file or failure.
  // Shared upload helper. Uploads `file` to R2 via the presigned-URL
  // flow, mirrors the URL into the project row immediately, and
  // returns the public URL. Used by both the file-picker onChange
  // (upload on select) and the Assemble click path (retry if state
  // somehow has a file but no URL). The DB persist is fire-and-forget
  // — UI already reflects the upload, a transient persist failure
  // shouldn't block the user.
  async function uploadAndPersist(
    file: File,
    kind: "bgm" | "logo",
  ): Promise<string | null> {
    const folder = kind === "bgm" ? "background-music" : "channel-logo";
    const column = kind === "bgm" ? "background_music_url" : "logo_url";
    const setUploading = kind === "bgm" ? setBgmUploading : setLogoUploading;
    const setUrl = kind === "bgm" ? setBgmUploadedUrl : setLogoUploadedUrl;
    setUploading(true);
    try {
      const url = await presignedUpload(file, projectId, folder);
      setUrl(url);
      fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [column]: url }),
      }).catch(() => { /* non-blocking */ });
      return url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `${kind === "bgm" ? "Music" : "Logo"} upload failed`);
      return null;
    } finally {
      setUploading(false);
    }
  }

  async function ensureBgmUploaded(): Promise<string | null> {
    if (!bgmFile) return null;
    if (bgmUploadedUrl) return bgmUploadedUrl;
    return uploadAndPersist(bgmFile, "bgm");
  }

  async function ensureLogoUploaded(): Promise<string | null> {
    if (!logoFile) return null;
    if (logoUploadedUrl) return logoUploadedUrl;
    return uploadAndPersist(logoFile, "logo");
  }

  // Clear local state AND the persisted URL on the project row so
  // refresh doesn't re-hydrate a logo the user just removed. The PATCH
  // is best-effort — local state changes regardless so the UI updates
  // immediately even if the network blip the row update.
  function clearLogo() {
    const hadPersisted = !!logoUploadedUrl;
    setLogoFile(null);
    setLogoUploadedUrl(null);
    if (logoInputRef.current) logoInputRef.current.value = "";
    if (hadPersisted) {
      fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ logo_url: null }),
      }).catch(() => { /* non-blocking */ });
    }
  }

  function clearBgm() {
    const hadPersisted = !!bgmUploadedUrl;
    setBgmFile(null);
    setBgmUploadedUrl(null);
    if (bgmInputRef.current) bgmInputRef.current.value = "";
    if (hadPersisted) {
      fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ background_music_url: null }),
      }).catch(() => { /* non-blocking */ });
    }
  }

  async function assembleVideo() {
    if (assembling) return;
    // Whether this is a first assembly or a confirmed reassemble, the
    // config panel is the launch path — drop reassembleMode here so a
    // successful run swaps cleanly back to the video-player view.
    setReassembleMode(false);
    setAssembling(true);
    setAssembledUrl(null);
    setAssembleStatus(trimSilence ? "Queuing (trim silences)…" : "Queuing…");
    try {
      // Upload background music first (if a file was picked but hasn't
      // been uploaded yet). The worker downloads from this URL during
      // the mix step.
      //
      // Initialize from the persisted/hydrated URL so a hydrated row
      // (page refresh + no new pick) still ships the previous selection
      // to the worker. A fresh File pick overrides via ensure*Uploaded.
      //
      // If a file is picked but upload fails, abort here. Quietly
      // sending `null` to the worker produced a video without music or
      // logo and hid the progress rows — the user thought it worked.
      let bgmUrl: string | null = bgmUploadedUrl;
      if (bgmFile) {
        setAssembleStatus("Uploading background music…");
        bgmUrl = await ensureBgmUploaded();
        if (!bgmUrl) throw new Error("Background music upload failed — please try again");
      }
      let logoUploadUrl: string | null = logoUploadedUrl;
      if (logoFile) {
        setAssembleStatus("Uploading channel logo…");
        logoUploadUrl = await ensureLogoUploaded();
        if (!logoUploadUrl) throw new Error("Channel logo upload failed — please try again");
      }
      setAssembleStatus(trimSilence ? "Queuing (trim silences)…" : "Queuing…");
      console.log("[assemble] submitting", { bgmUrl, bgmVolume, logoUploadUrl, logoX, logoY, logoSize, bgmFile: !!bgmFile, logoFile: !!logoFile, bgmUploadedUrl, logoUploadedUrl });
      const res = await fetch("/api/generate/assemble", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          aspectRatio,
          voiceoverType: "original",
          captionsEnabled,
          captionsLanguage,
          captionsStyle,
          captionsSize,
          captionsPosition,
          trimSilenceEnabled: trimSilence,
          backgroundMusicUrl: bgmUrl,
          backgroundMusicVolume: bgmVolume,
          resolution: selectedResolution,
          logoUrl: logoUploadUrl,
          logoX, logoY, logoSize,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to queue assembly");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Assembly failed");
      setAssembling(false);
      setAssembleStatus("");
    }
  }

  async function retryUpload() {
    if (assembling) return;
    setAssembling(true);
    setAssembleStatus("Uploading…");
    try {
      const res = await fetch("/api/generate/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to start upload");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
      setAssembling(false);
      setAssembleStatus("");
    }
  }

  // Per-beat voiceovers (current default) live on beat rows, not on
  // the project's legacy tts_url / tts_cleaned_url. The Assemble
  // button below gates on this flag, so without the beat-level check
  // the button stays disabled on every per-beat project even when
  // the previews above are happily playing the per-beat audio.
  const hasVoiceover = !!(ttsCleanedUrl || ttsUrl) || beats.some((b) => !!b.voiceoverUrl);
  const uploadFailedPreview = project?.assembly_status === "preview" && !project?.assembled_url;

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "var(--bg-page-2)" }}>
      <WizardNav projectId={projectId} currentState={15} highestState={project?.current_state} channelName={project?.channel_name} />

      <main className="flex-1 overflow-y-auto pt-[105px] md:pt-0 lg:px-[15px]">
        {/* Header */}
        <div className="px-5 sm:px-8 lg:px-[60px] py-4 sm:py-5"
          style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}>
          <div>
            <h1 className="font-bold text-base sm:text-lg">Assemble Final Video</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              Transcribes your voiceover to align each clip to the exact narration timing
            </p>
            <div className="mt-3 flex items-center gap-2 flex-wrap">
              <StepCostCard projectId={projectId} column="assemble" />
              <StepBalanceCard />
            </div>
          </div>
        </div>

        <div className="px-5 sm:px-8 lg:px-[60px] py-4 sm:py-8 pb-24">
          <div className="w-full space-y-6">

            {/* Status cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3">
              <div className="p-4 rounded-2xl" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Voiceover</p>
                <p className="mt-2 text-sm font-medium"
                  style={{ color: !hasVoiceover ? "var(--c-45)" : trimSilence ? "oklch(0.7 0.15 145)" : "oklch(0.72 0.25 285)" }}>
                  {!hasVoiceover ? "Missing" : trimSilence ? "Trimmed ✓" : "Original"}
                </p>
              </div>
              <div className="p-4 rounded-2xl" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Video Clips</p>
                <p className="mt-2 text-sm font-medium"
                  style={{ color: generatedVideos > 0 ? "oklch(0.72 0.25 285)" : "var(--c-45)" }}>
                  {generatedVideos} / {videoBeats}
                </p>
                {generatedVideos < videoBeats && (
                  <p className="text-xs mt-1" style={{ color: "var(--c-40)" }}>
                    {videoBeats - generatedVideos} will use still images
                  </p>
                )}
              </div>
              <div className="p-4 rounded-2xl space-y-2" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Output</p>
                <p className="text-sm font-medium" style={{ color: "var(--c-65)" }}>{dimsFor(aspectRatio, selectedResolution).label}</p>
                <div className="grid grid-cols-4 gap-1.5">
                  {RESOLUTION_PRESETS.map((p) => {
                    const isProOnly = PRO_RESOLUTIONS.has(p);
                    const locked = isProOnly && !canUsePro;
                    const active = selectedResolution === p;
                    return (
                      <button
                        key={p}
                        onClick={() => {
                          if (locked) {
                            // Pop the SubscriptionModal so the user
                            // can upgrade in-place rather than just
                            // being told "no" by a toast.
                            setShowUpgradeModal(true);
                            return;
                          }
                          setSelectedResolution(p);
                        }}
                        disabled={assembling}
                        title={locked
                          ? `Pro plan unlocks ${p} (${dimsFor(aspectRatio, p).label}) — click to upgrade`
                          : `Render at ${dimsFor(aspectRatio, p).label}`}
                        className="w-full py-1 rounded-md text-[10px] font-semibold transition-all disabled:opacity-40 inline-flex items-center justify-center gap-1"
                        style={active ? {
                          background: "oklch(0.72 0.25 285 / 0.18)",
                          border: "1px solid oklch(0.72 0.25 285 / 0.45)",
                          color: "oklch(0.88 0.12 285)",
                        } : {
                          background: "var(--bg-input)",
                          border: "1px solid var(--bd-card)",
                          color: "var(--c-50)",
                        }}
                      >
                        {p}
                        {isProOnly && (
                          <span
                            className="text-[8px] px-1 py-px rounded leading-none uppercase font-bold tracking-wide"
                            style={{
                              background: "oklch(0.72 0.25 285)",
                              color: "white",
                            }}
                          >
                            Pro
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Aspect ratio */}
            <div className="rounded-2xl p-5" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
              <p className="text-xs font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--c-40)" }}>
                Output Aspect Ratio{" "}
                <span className="normal-case font-normal" style={{ color: "var(--c-35)" }}>· matches your generated images</span>
              </p>
              {/* Read-only: the output must match the ratio the images (and
                  therefore the clips) were generated at — changing it here
                  would letterbox/crop every beat. Locked to the project's
                  generation aspect ratio. */}
              <span className="inline-flex px-4 py-2 rounded-xl text-xs font-medium"
                style={{ background: "oklch(0.72 0.25 285 / 0.15)", border: "1px solid oklch(0.72 0.25 285 / 0.4)", color: "oklch(0.88 0.12 285)" }}>
                {aspectRatio}
              </span>
            </div>

            {/* Background music — compact single-bar picker. Pre-pick
                shows label + Choose file. Post-pick collapses every
                control (filename, size, upload status, volume slider,
                remove ×) into one horizontal row to keep the assemble
                page dense. The chip + play-with-preview toggle still
                renders inside each preview card. */}
            <div className="flex items-center gap-3 rounded-2xl px-4 py-2.5 flex-wrap"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
              <span aria-hidden="true" className="text-base shrink-0" style={{ color: "oklch(0.72 0.25 285)" }}>♫</span>
              {!bgmFile && !bgmUploadedUrl ? (
                <>
                  <p className="text-sm font-semibold flex-1">Background music</p>
                  <button
                    onClick={() => bgmInputRef.current?.click()}
                    disabled={assembling}
                    className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40 transition-all shrink-0"
                    style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.88 0.12 285)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}
                  >
                    Choose file
                  </button>
                </>
              ) : (
                <>
                  {/* Play/pause preview — appears once a track is
                      selected/uploaded so the user can hear it before
                      assembling. Uses the local blob when available,
                      else the saved R2 URL. */}
                  {(() => {
                    const bgmPreviewSrc = bgmObjectUrl ?? bgmUploadedUrl;
                    if (!bgmPreviewSrc) return null;
                    return (
                      <>
                        <button
                          type="button"
                          onClick={() => {
                            const a = bgmAudioRef.current;
                            if (!a) return;
                            if (a.paused) {
                              a.volume = Math.max(0, Math.min(1, bgmVolume));
                              a.play().catch(() => {});
                            } else {
                              a.pause();
                            }
                          }}
                          title={bgmPlaying ? "Pause preview" : "Play preview"}
                          aria-label={bgmPlaying ? "Pause background music" : "Play background music"}
                          className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-transform hover:scale-105"
                          style={{ background: "oklch(0.72 0.25 285)", color: "#fff" }}
                        >
                          {bgmPlaying ? (
                            <span className="flex gap-[2px]">
                              <span className="block w-[3px] h-3 rounded-sm" style={{ background: "currentColor" }} />
                              <span className="block w-[3px] h-3 rounded-sm" style={{ background: "currentColor" }} />
                            </span>
                          ) : (
                            <span
                              className="block w-0 h-0 ml-[2px]"
                              style={{ borderLeft: "8px solid currentColor", borderTop: "5px solid transparent", borderBottom: "5px solid transparent" }}
                            />
                          )}
                        </button>
                        <audio
                          ref={bgmAudioRef}
                          src={bgmPreviewSrc}
                          preload="none"
                          onPlay={() => setBgmPlaying(true)}
                          onPause={() => setBgmPlaying(false)}
                          onEnded={() => setBgmPlaying(false)}
                        />
                      </>
                    );
                  })()}
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--c-40)" }}>
                      Background music
                    </p>
                    <p className="text-xs font-medium truncate" style={{ color: "var(--c-80)" }} title={bgmFile?.name ?? bgmUploadedUrl ?? ""}>
                      {bgmFile ? bgmFile.name : (bgmUploadedUrl?.split("/").pop() ?? "Saved track")}
                    </p>
                    <p className="text-[10px]" style={{ color: "var(--c-40)" }}>
                      {bgmFile
                        ? `${(bgmFile.size / (1024 * 1024)).toFixed(1)} MB${bgmUploadedUrl ? " · Uploaded" : bgmUploading ? " · Uploading…" : " · Not uploaded yet"}`
                        : "Saved from a previous run"}
                    </p>
                    <button
                      type="button"
                      onClick={() => setBgmDisclaimerOpen(true)}
                      className="text-[10px] underline underline-offset-2 hover:opacity-80"
                      style={{ color: "oklch(0.7 0.22 25)" }}
                    >
                      Disclaimer
                    </button>
                  </div>
                  <div className="flex items-center gap-2 w-full sm:w-auto sm:shrink-0">
                    <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--c-40)" }}>Vol</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={bgmVolume}
                      onChange={(e) => setBgmVolume(parseFloat(e.target.value))}
                      disabled={assembling}
                      aria-label="Background music volume"
                      className="flex-1 sm:flex-none sm:w-32"
                    />
                    <span className="text-[11px] font-mono tabular-nums w-9 text-right" style={{ color: "var(--c-60)" }}>
                      {Math.round(bgmVolume * 100)}%
                    </span>
                    <button
                      onClick={clearBgm}
                      disabled={assembling || bgmUploading}
                      title="Remove background music"
                      className="w-7 h-7 rounded-lg flex items-center justify-center transition-opacity hover:opacity-90 disabled:opacity-40 shrink-0"
                      style={{ background: "transparent", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}
                    >
                      ×
                    </button>
                  </div>
                </>
              )}
              <input
                ref={bgmInputRef}
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  if (!f) return;
                  setBgmFile(f);
                  // New file → invalidate any previously-uploaded URL
                  // and immediately upload + persist so a refresh
                  // doesn't lose the selection. Fire-and-forget
                  // since the user may continue tweaking other
                  // settings while the upload runs in the background.
                  setBgmUploadedUrl(null);
                  void uploadAndPersist(f, "bgm");
                }}
              />
            </div>

            {/* Channel logo — single-bar picker matching the bgm
                section. Pre-pick shows label + Choose file. Once a
                file is selected, the bar expands with an aspect-
                ratio drag surface where the user positions the logo,
                a width slider, and the × clear. Position and size
                are stored as 0–1 fractions of video dimensions so
                they're resolution-agnostic. */}
            <div className="rounded-2xl px-4 py-2.5 space-y-3"
              style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
              <div className="flex items-center gap-3 flex-wrap">
                <span aria-hidden="true" className="text-base shrink-0" style={{ color: "oklch(0.72 0.25 285)" }}>◈</span>
                {!logoFile && !logoUploadedUrl ? (
                  <>
                    <p className="text-sm font-semibold flex-1">Channel logo</p>
                    <button
                      onClick={() => logoInputRef.current?.click()}
                      disabled={assembling}
                      className="px-3 py-1.5 rounded-lg text-xs font-semibold disabled:opacity-40 transition-all shrink-0"
                      style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.88 0.12 285)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}
                    >
                      Choose file
                    </button>
                  </>
                ) : (
                  <>
                    <div className="min-w-0 flex-1">
                      <p className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--c-40)" }}>
                        Channel logo
                      </p>
                      <p className="text-xs font-medium truncate" style={{ color: "var(--c-80)" }} title={logoFile?.name ?? logoUploadedUrl ?? ""}>
                        {logoFile ? logoFile.name : (logoUploadedUrl?.split("/").pop() ?? "Saved logo")}
                      </p>
                      <p className="text-[10px]" style={{ color: "var(--c-40)" }}>
                        {logoFile
                          ? `${(logoFile.size / 1024).toFixed(0)} KB${logoUploadedUrl ? " · Uploaded" : logoUploading ? " · Uploading…" : " · Not uploaded yet"}`
                          : "Saved from a previous run"}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 w-full sm:w-auto sm:shrink-0">
                      <span className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--c-40)" }}>Size</span>
                      <input
                        type="range"
                        min={0.03}
                        max={0.4}
                        step={0.01}
                        value={logoSize}
                        onChange={(e) => setLogoSize(parseFloat(e.target.value))}
                        disabled={assembling}
                        aria-label="Logo size"
                        className="flex-1 sm:flex-none sm:w-32"
                      />
                      <span className="text-[11px] font-mono tabular-nums w-9 text-right" style={{ color: "var(--c-60)" }}>
                        {Math.round(logoSize * 100)}%
                      </span>
                      <button
                        onClick={clearLogo}
                        disabled={assembling || logoUploading}
                        title="Remove channel logo"
                        className="w-7 h-7 rounded-lg flex items-center justify-center transition-opacity hover:opacity-90 disabled:opacity-40 shrink-0"
                        style={{ background: "transparent", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}
                      >
                        ×
                      </button>
                    </div>
                  </>
                )}
                <input
                  ref={logoInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    if (!f) return;
                    setLogoFile(f);
                    setLogoUploadedUrl(null);
                    // Immediately upload + persist (same reasoning as bgm above).
                    void uploadAndPersist(f, "logo");
                  }}
                />
              </div>
              {(logoObjectUrl || logoUploadedUrl) && (() => {
                // Draggable preview surface. The surface holds the
                // current aspect ratio (16:9 / 9:16 / 1:1). Logo is
                // an absolutely positioned img the user drags around.
                // Position is stored as 0–1 fractions of the surface
                // dimensions, mirroring how the worker interprets
                // logoX / logoY against the actual video.
                // Source: blob URL for a freshly-picked File, otherwise
                // the persisted R2 URL hydrated from the project row.
                const logoSrc = logoObjectUrl ?? logoUploadedUrl!;
                const aspect = aspectRatio.replace(":", " / ");
                function onDragLogo(e: React.PointerEvent<HTMLImageElement>) {
                  e.preventDefault();
                  e.stopPropagation();
                  const surface = (e.currentTarget.parentElement?.parentElement as HTMLElement | null);
                  if (!surface) return;
                  const img = e.currentTarget;
                  img.setPointerCapture(e.pointerId);
                  const startBox = surface.getBoundingClientRect();
                  const offsetX = e.clientX - img.getBoundingClientRect().left;
                  const offsetY = e.clientY - img.getBoundingClientRect().top;
                  function move(ev: PointerEvent) {
                    const localX = ev.clientX - startBox.left - offsetX;
                    const localY = ev.clientY - startBox.top - offsetY;
                    // Clamp so the logo can't be dragged outside the
                    // visible video area. We don't know the rendered
                    // logo width yet (it depends on size %), but the
                    // worker also clamps via overlay's auto, so a
                    // simple [0, 1 - logoSize] keeps it sensible.
                    const maxX = 1 - logoSize;
                    const surfaceAspect = startBox.height / startBox.width;
                    // Approx maxY using the logo's render height ≈
                    // logoSize * surface width / image natural ratio.
                    const approxLogoHpct = (img.offsetHeight / startBox.height);
                    const maxY = Math.max(0, 1 - approxLogoHpct);
                    const nextX = Math.max(0, Math.min(maxX, localX / startBox.width));
                    const nextY = Math.max(0, Math.min(maxY, localY / startBox.height));
                    setLogoX(nextX);
                    setLogoY(nextY);
                    void surfaceAspect;
                  }
                  function up(ev: PointerEvent) {
                    img.releasePointerCapture(ev.pointerId);
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", up);
                  }
                  window.addEventListener("pointermove", move);
                  window.addEventListener("pointerup", up);
                }
                // Resize via dragging the bottom-right handle. Stops
                // pointer propagation so the move handler on the img
                // doesn't also fire. New width = pointer x − logo
                // left edge, expressed as fraction of surface width.
                // Clamped to the same 0.03–0.40 range as the slider.
                function onResizeLogo(e: React.PointerEvent<HTMLSpanElement>) {
                  e.preventDefault();
                  e.stopPropagation();
                  const handle = e.currentTarget;
                  const surface = handle.parentElement?.parentElement as HTMLElement | null;
                  if (!surface) return;
                  handle.setPointerCapture(e.pointerId);
                  const startBox = surface.getBoundingClientRect();
                  // Capture current logo left edge in px so we measure
                  // from there regardless of where the pointer lands.
                  const logoLeftPx = startBox.left + logoX * startBox.width;
                  function move(ev: PointerEvent) {
                    const newWidthPx = Math.max(0, ev.clientX - logoLeftPx);
                    const newSize = Math.max(0.03, Math.min(0.4, newWidthPx / startBox.width));
                    // Don't push past the right edge: if the new size
                    // would overflow given the current x, clamp size.
                    const maxSize = Math.max(0.03, 1 - logoX);
                    setLogoSize(Math.min(newSize, maxSize));
                  }
                  function up(ev: PointerEvent) {
                    handle.releasePointerCapture(ev.pointerId);
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", up);
                  }
                  window.addEventListener("pointermove", move);
                  window.addEventListener("pointerup", up);
                }
                return (
                  <div className="space-y-1.5">
                    <p className="text-[10px] uppercase tracking-wider font-semibold" style={{ color: "var(--c-40)" }}>
                      Drag to position · drag corner to resize
                    </p>
                    <div
                      className="relative w-full rounded-lg overflow-hidden select-none"
                      style={{
                        aspectRatio: aspect,
                        maxWidth: "320px",
                        background: "linear-gradient(135deg, oklch(0.16 0 0), oklch(0.22 0 0))",
                        border: "1px solid var(--bd-card)",
                      }}
                    >
                      <div
                        className="absolute group"
                        style={{
                          left: `${logoX * 100}%`,
                          top: `${logoY * 100}%`,
                          width: `${logoSize * 100}%`,
                        }}
                      >
                        <img
                          src={logoSrc}
                          alt={logoFile?.name ?? "Channel logo"}
                          draggable={false}
                          onPointerDown={assembling ? undefined : onDragLogo}
                          className="touch-none block w-full h-auto"
                          style={{
                            cursor: assembling ? "default" : "grab",
                            opacity: 0.95,
                            filter: "drop-shadow(0 2px 8px oklch(0 0 0 / 0.5))",
                          }}
                        />
                        {/* Bottom-right resize handle. Visible at all
                            times so it's discoverable; sized small so
                            it doesn't obscure tiny logos. */}
                        {!assembling && (
                          <span
                            onPointerDown={onResizeLogo}
                            aria-label="Resize logo"
                            title="Drag to resize"
                            className="absolute touch-none flex items-center justify-center"
                            style={{
                              right: "-6px",
                              bottom: "-6px",
                              width: "14px",
                              height: "14px",
                              borderRadius: "9999px",
                              background: "oklch(0.72 0.25 285)",
                              border: "2px solid #ffffff",
                              cursor: "nwse-resize",
                              boxShadow: "0 0 0 1px oklch(0.4 0.15 285)",
                            }}
                          />
                        )}
                      </div>
                    </div>
                    <p className="text-[10px] font-mono tabular-nums" style={{ color: "var(--c-40)" }}>
                      x: {Math.round(logoX * 100)}% · y: {Math.round(logoY * 100)}% · size: {Math.round(logoSize * 100)}%
                    </p>
                  </div>
                );
              })()}
            </div>

            {/* Voiceover source — the two preview cards double as the
                selector. Clicking a card sets trimSilence; the active
                card gets a theme-color background tint. The play button
                inside each card stops propagation so audio toggling
                doesn't trip the selection. */}
            <div className="space-y-3">
              {(() => {
                // Project data is undefined while SWR is still fetching —
                // we don't know yet if voiceovers exist, so pessimistically
                // show the loader. Once project loads, swap to the
                // voiceover-aware condition so the loader hides cleanly
                // when there's nothing to preview.
                const projectLoaded = !!project;
                const hasAnyVoiceover = beats.some((b) => !!b.voiceoverUrl);
                const showLoading = !projectLoaded || (hasAnyVoiceover && (trimmedLoading || originalLoading));
                return (
                  <div className="flex items-center gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--c-40)" }}>Voiceover Source</p>
                    {showLoading && (
                      <span className="flex items-center gap-1.5 text-[11px]" style={{ color: "oklch(0.72 0.25 285)" }}>
                        <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        Loading previews…
                      </span>
                    )}
                  </div>
                );
              })()}

              {beats.some((b) => !!b.voiceoverUrl) && (
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                  <FullVoiceoverPreview
                    projectId={projectId}
                    beats={beats}
                    trimSilence={true}
                    title="Trimmed voiceover"
                    selected={trimSilence}
                    onSelect={assembling || !hasVoiceover ? undefined : () => setTrimSilence(true)}
                    onLoadingChange={setTrimmedLoading}
                    bgmUrl={bgmObjectUrl ?? bgmUploadedUrl}
                    bgmName={bgmFile?.name ?? bgmUploadedUrl?.split("/").pop() ?? undefined}
                    bgmVolume={bgmVolume}
                  />
                  <FullVoiceoverPreview
                    projectId={projectId}
                    beats={beats}
                    trimSilence={false}
                    title="Original voiceover"
                    selected={!trimSilence}
                    onSelect={assembling || !hasVoiceover ? undefined : () => setTrimSilence(false)}
                    onLoadingChange={setOriginalLoading}
                    bgmUrl={bgmObjectUrl ?? bgmUploadedUrl}
                    bgmName={bgmFile?.name ?? bgmUploadedUrl?.split("/").pop() ?? undefined}
                    bgmVolume={bgmVolume}
                  />
                </div>
              )}
            </div>

            {/* Captions */}
            <div className="rounded-2xl p-5" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <p className="text-sm font-semibold">Captions</p>
                  <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>Burned into the video — always visible</p>
                </div>
                <button onClick={() => setCaptionsEnabled((v) => !v)} disabled={assembling}
                  className="relative w-11 h-6 rounded-full transition-all disabled:opacity-40 shrink-0"
                  style={{ background: captionsEnabled ? "oklch(0.72 0.25 285)" : "var(--c-22)", border: "1px solid var(--bd-10)" }}>
                  <span className="absolute top-0.5 w-5 h-5 rounded-full transition-all"
                    style={{ background: "oklch(0.95 0 0)", left: captionsEnabled ? "calc(100% - 1.375rem)" : "0.125rem" }} />
                </button>
              </div>

              {captionsEnabled && (
                <div className="space-y-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Style</p>
                    <div className="grid grid-cols-2 gap-1.5">
                      {CAPTION_STYLES.map((s) => (
                        <button key={s.id} onClick={() => setCaptionsStyle(s.id)} disabled={assembling}
                          className="py-2 px-3 rounded-xl text-left transition-all disabled:opacity-40"
                          style={captionsStyle === s.id ? {
                            background: "oklch(0.72 0.25 285 / 0.15)",
                            border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                          } : {
                            background: "var(--bg-input)",
                            border: "1px solid var(--bd-card)",
                          }}>
                          <p className="text-xs font-medium" style={{ color: captionsStyle === s.id ? "oklch(0.88 0.12 285)" : "var(--c-60)" }}>{s.label}</p>
                          <p className="text-xs mt-0.5" style={{ color: "var(--c-38)" }}>{s.hint}</p>
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex gap-4">
                    <div className="flex-1">
                      <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Size</p>
                      <div className="flex gap-1.5">
                        {CAPTION_SIZES.map((s) => (
                          <button key={s.id} onClick={() => setCaptionsSize(s.id)} disabled={assembling}
                            className="flex-1 py-1.5 rounded-xl text-xs font-semibold transition-all disabled:opacity-40"
                            style={captionsSize === s.id ? {
                              background: "oklch(0.72 0.25 285 / 0.15)",
                              border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                              color: "oklch(0.88 0.12 285)",
                            } : {
                              background: "var(--bg-input)",
                              border: "1px solid var(--bd-card)",
                              color: "var(--c-50)",
                            }}>
                            {s.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="flex-1">
                      <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Position</p>
                      <div className="flex gap-1.5">
                        {CAPTION_POSITIONS.map((p) => (
                          <button key={p.id} onClick={() => setCaptionsPosition(p.id)} disabled={assembling}
                            className="flex-1 py-1.5 rounded-xl text-xs font-medium transition-all disabled:opacity-40"
                            style={captionsPosition === p.id ? {
                              background: "oklch(0.72 0.25 285 / 0.15)",
                              border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                              color: "oklch(0.88 0.12 285)",
                            } : {
                              background: "var(--bg-input)",
                              border: "1px solid var(--bd-card)",
                              color: "var(--c-50)",
                            }}>
                            {p.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--c-40)" }}>Language</p>
                    <div className="flex flex-wrap gap-1.5">
                      {CAPTION_LANGUAGES.map((lang) => (
                        <button key={lang.code} onClick={() => setCaptionsLanguage(lang.code)} disabled={assembling}
                          className="px-3 py-1.5 rounded-xl text-xs font-medium transition-all disabled:opacity-40"
                          style={captionsLanguage === lang.code ? {
                            background: "oklch(0.72 0.25 285 / 0.15)",
                            border: "1px solid oklch(0.72 0.25 285 / 0.4)",
                            color: "oklch(0.88 0.12 285)",
                          } : {
                            background: "var(--bg-input)",
                            border: "1px solid var(--bd-card)",
                            color: "var(--c-50)",
                          }}>
                          {lang.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Assembly controls */}
            <div className="rounded-2xl p-5 space-y-4" style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-card)" }}>
              {showPreview && previewUrl && !previewLoadError && (
                <video
                  key={previewUrl}
                  src={previewUrl}
                  controls
                  // Size to the clip's own aspect ratio: width fills up to
                  // the panel, height is capped so a 9:16 portrait render
                  // doesn't blow up — the video keeps its true shape and
                  // centers instead of stretching.
                  className="mx-auto block max-h-[70vh] rounded-xl"
                  style={{ background: "var(--bg-page-2)", maxWidth: "100%" }}
                  onError={() => setPreviewLoadError(true)}
                  onLoadedMetadata={() => setPreviewLoadError(false)}
                />
              )}
              {showPreview && previewLoadError && (
                <div
                  className="w-full rounded-xl p-5 text-center space-y-1"
                  style={{ background: "var(--bg-page-2)", border: "1px solid var(--bd-card)" }}
                >
                  <p className="text-sm font-medium" style={{ color: "var(--c-78)" }}>
                    Preview unavailable
                  </p>
                  <p className="text-xs" style={{ color: "var(--c-50)" }}>
                    The cached preview file may have expired. Click Reassemble to rebuild it.
                  </p>
                </div>
              )}

              {/* In-progress preview — visible while assembling, only
                  after the worker has uploaded mixed.mp4. The video is
                  watchable but is missing the final-burn pass (captions
                  + logo bake + upscale), so we label it clearly so the
                  user knows the cosmetic touch-ups are still rendering. */}
              {assembling && inProgressPreviewUrl && (
                <div className="space-y-2">
                  <video
                    key={inProgressPreviewUrl}
                    src={inProgressPreviewUrl}
                    controls
                    className="mx-auto block max-h-[70vh] rounded-xl"
                    style={{ background: "var(--bg-page-2)", maxWidth: "100%" }}
                  />
                  <p className="text-sm text-center font-medium leading-snug" style={{ color: "oklch(0.72 0.18 60)" }}>
                    Preview — finishing up
                  </p>
                </div>
              )}

              {assembling && (() => {
                /* Stage-aware progress: the worker emits short status strings
                   for each phase via setProgress(); we match the current one
                   to a known stage and render every stage with a done/doing/
                   pending indicator + an overall % bar.

                   `paused` freezes the animations the moment the user clicks
                   Stop. Without this the per-step spinner + indeterminate
                   stripe keep moving while we wait the few seconds for the
                   worker to acknowledge — visually indistinguishable from
                   normal progress, which makes the Stop click feel ignored.
                   Active when stopRequested (user clicked Stop),
                   finalizeRequested (user clicked Use this version), or
                   the worker has already transitioned to "stopped". */
                const paused = stopRequested || finalizeRequested || project?.assembly_status === "stopped";
                const stopped = project?.assembly_status === "stopped";
                // Matchers are tightened so each one only catches its own
                // worker progress string. The old "Downloading" prefix
                // greedily swallowed bgm and logo downloads too, which
                // collapsed them into the voiceover stage and hid that they
                // were happening. The worker emits the exact strings shown
                // below (assemble.ts), so anchor to them precisely.
                // Stage list only includes stages that map to a real
                // worker pass after the assemble pipeline refactor:
                //   - Logo overlay was baked into normalizeClip — the
                //     "Downloading channel logo…" status is folded into
                //     the clips stage match because it's a brief prelude
                //     to clip processing, not its own pass.
                //   - Burning captions was baked into normalizeClip too,
                //     so the standalone "Burn captions" stage is gone.
                //   - "Generate captions" never had a worker progress
                //     line of its own; the only meaningful caption-prep
                //     wait is the optional translate call, kept as its
                //     own stage when captions translation is needed.
                //   - join only matches the final visuals concat now;
                //     "Joining per-beat audio…" lands in voiceover.
                // Five high-level stages. The previous 9-step layout
                // exposed pipeline internals (transcribe, translate,
                // download bgm, restore-from-checkpoint) that the
                // user can't act on and that change run-to-run based
                // on whether captions/translation/BGM are configured.
                // Collapsing into Prepare / Build clips / Mix audio /
                // Burn captions / Upload keeps the count stable and
                // the labels meaningful regardless of options.
                const stages = [
                  // Prepare: queue claim, voiceover ready, transcribe,
                  // translate, channel-logo download (the latter is
                  // an early-stage prereq, not part of clip encoding).
                  { key: "prepare",    label: "Prepare",         match: (s: string) => (
                    s.startsWith("Loading") || s === "Queued…" || s === "Starting…"
                    || s.startsWith("Preparing") || s.startsWith("Prepared") || s.startsWith("Downloading voiceover") || s === "Joining per-beat audio…"
                    || s.startsWith("Transcribing") || s.startsWith("Translating")
                  ) },
                  // Build clips: per-beat encode pass + the post-encode
                  // "Finalizing…" debounce the worker emits when a
                  // worker pool finishes its last beat.
                  { key: "clips",      label: "Build clips",     match: (s: string) => s.startsWith("Processing") || s.startsWith("Finalizing") },
                  // Mix audio: join clips, freeze-pad, BGM + logo
                  // download, and the actual mix pass. Logo download
                  // lives here now (used to be a Stage B prereq) so
                  // both BGM and logo prep land in one user-visible
                  // step. The freeze-pad only fires in legacy mode
                  // with trailing silence; folding it in keeps step
                  // counts run-stable.
                  { key: "mix",        label: "Mix audio",       match: (s: string) => (
                    s === "Joining clips…" || s.startsWith("Padding video") || s.startsWith("Restoring joined") || s.startsWith("Restoring padded")
                    || s.startsWith("Downloading background music") || s.startsWith("Downloading channel logo")
                    || s.startsWith("Mixing") || s.startsWith("Restoring mixed")
                  ) },
                  // Stage F removed in the post-Coconut refactor.
                  // Captions are baked per-beat during Build clips;
                  // logo composites at Mix audio; there's no final-
                  // burn pass anymore. mixed.mp4 IS the final video,
                  // which uploads directly from Stage D's output.
                  { key: "upload",     label: "Upload",          match: (s: string) => s.startsWith("Uploading") },
                ];
                // Monotonic stage index: once we've seen progress to
                // a later stage, don't ever fall back to an earlier
                // one. The worker occasionally writes transient
                // status lines that don't match any rule (e.g. a
                // "Validating…" / "Cleaning up…" between stages),
                // which would otherwise drop findIndex to -1 and
                // make the progress bar visibly jump back to step 1
                // before snapping forward on the next matching line.
                const i = stages.findIndex((s) => s.match(assembleStatus));
                if (i > lastStageIdxRef.current) lastStageIdxRef.current = i;
                else if (i === -1 && lastStageIdxRef.current === -1) lastStageIdxRef.current = 0;
                const currentIdx = lastStageIdxRef.current >= 0 ? lastStageIdxRef.current : 0;
                const pct = Math.round((currentIdx / stages.length) * 100);

                return (
                  <div className="space-y-3">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs" style={{ color: "var(--c-45)" }}>
                        <span>Step {currentIdx + 1} of {stages.length}</span>
                        <span>{pct}%</span>
                      </div>
                      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: "var(--bg-track)" }}>
                        <div className="h-full transition-all duration-500"
                          style={{ width: `${pct}%`, background: "oklch(0.72 0.25 285)" }} />
                      </div>
                    </div>

                    <ul className="space-y-2">
                      {stages.map((s, i) => {
                        const done = i < currentIdx;
                        const doing = i === currentIdx;
                        // While the in-progress preview is showing,
                        // the user already knows the early stages
                        // completed — they're watching the video.
                        // Collapse the list to only the still-active
                        // and pending steps so the panel focuses on
                        // what they're waiting for (Finalize, Upload).
                        // The overall % bar + "Step X of N" header
                        // above keep showing total progress.
                        if (inProgressPreviewUrl && done) return null;
                        /* Per-stage progress: parse "X of N" out of the status
                           when possible (clips stage). Otherwise we show an
                           indeterminate animated stripe so the user still sees
                           the stage is actively working. */
                        const clipMatch = doing ? assembleStatus.match(/(\d+)\s+of\s+(\d+)/i) : null;
                        const stagePct = done
                          ? 100
                          : doing && clipMatch
                          ? Math.round((parseInt(clipMatch[1], 10) / parseInt(clipMatch[2], 10)) * 100)
                          : 0;
                        const showIndeterminate = doing && !clipMatch;
                        // Active-step palette swaps to amber when paused so
                        // the row visually reads "halted here" rather than
                        // "still working." `pausedHere` only fires on the
                        // doing step; other steps keep their done/pending
                        // styling regardless.
                        const pausedHere = paused && doing;
                        return (
                          <li key={s.key} className="space-y-1">
                            <div className="flex items-center gap-2 text-xs">
                              <span className="w-4 h-4 rounded-full flex items-center justify-center shrink-0"
                                style={{
                                  background: done ? "oklch(0.55 0.15 145 / 0.15)" : pausedHere ? "oklch(0.65 0.18 60 / 0.15)" : doing ? "oklch(0.72 0.25 285 / 0.15)" : "var(--bg-track)",
                                  border: `1px solid ${done ? "oklch(0.55 0.15 145 / 0.4)" : pausedHere ? "oklch(0.65 0.18 60 / 0.5)" : doing ? "oklch(0.72 0.25 285 / 0.4)" : "var(--bd-7)"}`,
                                  color: done ? "oklch(0.7 0.15 145)" : pausedHere ? "oklch(0.72 0.18 60)" : doing ? "oklch(0.88 0.12 285)" : "var(--c-35)",
                                  fontSize: "9px",
                                }}>
                                {done ? "✓" : pausedHere ? (
                                  // Pause glyph: two short vertical bars.
                                  // Inline SVG so it inherits currentColor
                                  // and doesn't pull in an icon dep.
                                  <svg width="7" height="8" viewBox="0 0 6 8" fill="currentColor"><rect x="0" y="0" width="2" height="8" rx="0.5" /><rect x="4" y="0" width="2" height="8" rx="0.5" /></svg>
                                ) : doing ? (
                                  <span className="w-2 h-2 border-[1.5px] border-current border-t-transparent rounded-full animate-spin" />
                                ) : i + 1}
                              </span>
                              <span className="flex-1" style={{ color: done ? "var(--c-55)" : doing ? "var(--c-65)" : "var(--c-40)", fontWeight: doing ? 600 : 400 }}>
                                {/* The load stage bundles three meaningfully
                                   different states (Queued… / Starting… /
                                   Loading project data…) under one static
                                   label, so a user sitting in a queue can't
                                   tell whether the worker is busy with
                                   someone else's project or just slow to
                                   pick up theirs. When this is the active
                                   stage, surface the raw worker status
                                   instead of the catch-all label. Other
                                   stages keep their polished labels — their
                                   raw status strings are less readable. */}
                                {doing && s.key === "load" ? (assembleStatus || s.label) : s.label}
                              </span>
                              {doing && clipMatch && (
                                <span className="text-[10px]" style={{ color: "var(--c-55)" }}>{stagePct}%</span>
                              )}
                            </div>
                            <div className="ml-6 h-1 rounded-full overflow-hidden relative" style={{ background: "var(--bg-track)" }}>
                              {showIndeterminate && !pausedHere ? (
                                <div className="progress-indeterminate h-full"
                                  style={{ background: "oklch(0.72 0.25 285)" }} />
                              ) : pausedHere ? (
                                // Frozen stripe — solid amber at a fixed
                                // fill so the user can still see this is
                                // the active step, just not animating.
                                <div className="h-full"
                                  style={{ width: "30%", background: "oklch(0.72 0.18 60)" }} />
                              ) : (
                                <div className="h-full transition-all duration-500"
                                  style={{
                                    width: `${stagePct}%`,
                                    background: done ? "oklch(0.7 0.15 145)" : "oklch(0.72 0.25 285)",
                                  }} />
                              )}
                            </div>
                          </li>
                        );
                      })}
                    </ul>

                    <p className="text-[11px] text-center leading-snug" style={{ color: paused ? "oklch(0.7 0.15 60)" : "var(--c-45)" }}>
                      {/* While the worker is acknowledging an
                          interrupt, surface the right "…" line so
                          the click doesn't feel ignored. Once the
                          worker transitions to stopped/done, the
                          useEffect above sets assembleStatus to a
                          terminal line and we fall through. */}
                      {finalizeRequested && !stopped
                        ? "Stopping to confirm preview…"
                        : stopRequested && !stopped
                        ? "Stopping…"
                        : (assembleStatus || "Working…")}
                    </p>

                    {project?.assembly_status === "stopped" ? (
                      // Two stopped flavors:
                      //   - Stopped via "Use this version":
                      //     assembly_finalize_preview_requested stays
                      //     true after the worker's stop, signaling
                      //     the user wants to ship the preview. Show
                      //     Continue instead of Resume — clicking it
                      //     promotes the preview to assembled_url and
                      //     marks the assembly done without running
                      //     any remaining work.
                      //   - Stopped via Stop: the usual Resume path.
                      finalizeRequested ? (
                        <div className="flex gap-2">
                          <button onClick={() => setCancelAssemblyConfirmOpen(true)}
                            disabled={cancellingAssembly || committingPreview}
                            className="flex-1 py-2 rounded-xl text-xs font-medium transition-all hover:opacity-90 disabled:opacity-40"
                            style={{ background: "oklch(0.6 0.22 25 / 0.1)", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}>
                            Cancel
                          </button>
                          <button onClick={commitPreview}
                            disabled={cancellingAssembly || committingPreview}
                            className="flex-1 py-2 rounded-xl text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-40"
                            style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                            {committingPreview ? "Continuing…" : "Continue"}
                          </button>
                        </div>
                      ) : (
                        <div className="flex gap-2">
                          <button onClick={() => setCancelAssemblyConfirmOpen(true)}
                            disabled={cancellingAssembly}
                            className="flex-1 py-2 rounded-xl text-xs font-medium transition-all hover:opacity-90 disabled:opacity-40"
                            style={{ background: "oklch(0.6 0.22 25 / 0.1)", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}>
                            Cancel
                          </button>
                          <button onClick={resumeAssembly}
                            disabled={cancellingAssembly}
                            className="flex-1 py-2 rounded-xl text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-40"
                            style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                            Resume
                          </button>
                        </div>
                      )
                    ) : inProgressPreviewUrl ? (
                      // Two-button row whenever the in-progress preview
                      // is available: "Use this version" promotes the
                      // preview to the final assembled video and skips
                      // the remaining final-burn re-encode (saves 5-25
                      // min on long projects); Stop preserves the
                      // checkpoint for later Resume. Disabled-state
                      // labels reflect whichever click is in flight.
                      <div className="flex gap-2">
                        <button onClick={stopAssembly} disabled={stopRequested || finalizeRequested}
                          className="flex-1 py-2 rounded-xl text-xs font-medium transition-all hover:opacity-90 disabled:opacity-40"
                          style={{ background: "oklch(0.6 0.22 25 / 0.1)", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}>
                          {stopRequested ? "Stopping…" : "Stop"}
                        </button>
                        <button onClick={finalizeWithPreview} disabled={finalizeRequested || stopRequested}
                          className="flex-1 py-2 rounded-xl text-xs font-semibold transition-all hover:opacity-90 disabled:opacity-40"
                          style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                          {finalizeRequested ? "Finalizing…" : "Export anyway"}
                        </button>
                      </div>
                    ) : (
                      <button onClick={stopAssembly} disabled={stopRequested}
                        className="w-full py-2 rounded-xl text-xs font-medium transition-all hover:opacity-90 disabled:opacity-40"
                        style={{ background: "oklch(0.6 0.22 25 / 0.1)", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}>
                        {stopRequested ? "Stopping…" : "Stop"}
                      </button>
                    )}
                    <p className="text-[11px] text-center" style={{ color: "var(--c-35)" }}>Progress updates every ~5 seconds…</p>
                  </div>
                );
              })()}

              {showPreview && previewUrl && (
                <div className="mx-auto" style={{ maxWidth: previewMaxW }}>
                  <div className="flex gap-2">
                    <button onClick={() => setReassembleConfirmOpen(true)}
                      className="flex-1 py-2.5 rounded-xl text-xs font-medium transition-all"
                      style={previewLoadError
                        // When the preview can't load, Reassemble is the
                        // only path forward — promote it to the theme
                        // purple so it reads as the primary CTA.
                        ? { background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }
                        : { background: "var(--bg-progress)", color: "var(--c-60)", border: "1px solid var(--bd-card)" }}>
                      Reassemble
                    </button>
                    {/* Hide Export when the preview can't load — its
                        href points at the same URL the player just
                        failed on, so clicking it would 404 too.
                        Reassemble fills the row via flex-1.
                        The href goes through our export route (which
                        302s to a presigned attachment URL) instead of
                        the raw R2 URL — the anchor `download`
                        attribute is ignored cross-origin, so linking
                        R2 directly opened the video in the tab
                        instead of downloading it. */}
                    {!previewLoadError && (
                      <a
                        href={`/api/projects/${projectId}/export-video?url=${encodeURIComponent(previewUrl)}&filename=${encodeURIComponent(`${(project?.channel_name as string | undefined)?.trim() || "video"}.mp4`)}`}
                        className="flex-1 py-2.5 rounded-xl text-xs font-semibold text-center transition-all"
                        style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                        ↓ Export
                      </a>
                    )}
                  </div>
                  <button
                    onClick={() => router.push(`/projects/${projectId}/thumbnails`)}
                    disabled={previewLoadError}
                    title={previewLoadError ? "Reassemble the video before continuing — the cached preview can't be loaded." : undefined}
                    className="w-full py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)", marginTop: "50px", marginBottom: "20px" }}
                  >
                    Continue →
                  </button>
                </div>
              )}

              {!showPreview && !assembling && uploadFailedPreview && (
                <div className="space-y-2">
                  <div className="rounded-xl p-3" style={{ background: "oklch(0.6 0.22 25 / 0.08)", border: "1px solid oklch(0.6 0.22 25 / 0.25)" }}>
                    <p className="text-xs font-semibold" style={{ color: "oklch(0.7 0.2 25)" }}>
                      Upload to cloud failed
                    </p>
                    <p className="text-xs mt-1" style={{ color: "var(--c-55)" }}>
                      Your assembled video is preserved on the worker. Retry just the upload — no need to re-render.
                    </p>
                    {project?.assembly_error && (
                      <p className="text-[10px] mt-1.5 font-mono break-all" style={{ color: "var(--c-40)" }}>
                        {project.assembly_error as string}
                      </p>
                    )}
                  </div>
                  <button onClick={retryUpload} disabled={assembling}
                    className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-60 transition-all"
                    style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                    {assembling ? (
                      <span className="flex items-center justify-center gap-2">
                        <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                        Uploading…
                      </span>
                    ) : "Retry Upload"}
                  </button>
                  <button onClick={() => assembleVideo()} disabled={assembling}
                    className="w-full py-2 rounded-xl text-xs font-medium disabled:opacity-60 transition-all"
                    style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-card)", color: "var(--c-55)" }}>
                    {assembling ? "Queuing…" : "Or reassemble from scratch"}
                  </button>
                </div>
              )}

              {!showPreview && !assembling && !uploadFailedPreview && (
                <>
                  {reassembleMode && (
                    <p className="text-xs text-center py-1" style={{ color: "var(--c-50)" }}>
                      Reassembling — review the settings above, then click <strong>Assemble</strong> to start.
                    </p>
                  )}
                  {!hasVoiceover && (
                    <p className="text-xs text-center py-1" style={{ color: "var(--c-40)" }}>
                      Generate a voiceover on the Generate page first.
                    </p>
                  )}
                  <div className="flex gap-2">
                    {reassembleMode && (
                      <button onClick={() => setReassembleMode(false)} disabled={assembling}
                        className="flex-1 py-2.5 rounded-xl text-xs font-medium transition-all disabled:opacity-40"
                        style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-card)", color: "var(--c-55)" }}>
                        Cancel
                      </button>
                    )}
                    <button onClick={() => assembleVideo()} disabled={!hasVoiceover || assembling}
                      className={`${reassembleMode ? "flex-1" : "w-full"} py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all`}
                      style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}>
                      {assembling ? (
                        <span className="flex items-center justify-center gap-2">
                          <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          Queuing…
                        </span>
                      ) : reassembleMode ? "Assemble" : "Assemble Final Video"}
                    </button>
                  </div>
                </>
              )}
            </div>

          </div>{/* end left column */}

        </div>
      </main>

      <Dialog open={reassembleConfirmOpen} onOpenChange={(open) => { if (!clearingAssembled) setReassembleConfirmOpen(open); }}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Reassemble video?</DialogTitle>
            <DialogDescription>
              This will <strong>permanently delete</strong> the current assembled video from storage and clear the preview. You&apos;ll then be able to choose the voiceover and adjust the captions / aspect ratio before starting a fresh run. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setReassembleConfirmOpen(false)}
              disabled={clearingAssembled}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-40"
              style={{ background: "transparent", border: "1px solid var(--bd-card)", color: "var(--c-60)" }}
            >
              Cancel
            </button>
            <button
              onClick={confirmReassemble}
              disabled={clearingAssembled}
              className="px-4 py-2 rounded-lg text-sm font-semibold transition-all disabled:opacity-60"
              style={{ background: "oklch(0.6 0.22 25)", color: "var(--bg-page-2)" }}
            >
              {clearingAssembled ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Deleting…
                </span>
              ) : "Delete & reassemble"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={bgmDisclaimerOpen} onOpenChange={setBgmDisclaimerOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Background music disclaimer</DialogTitle>
            <DialogDescription>
              We do not take responsibility for copyright claims on background music. Please ensure you have the rights to use any track you upload.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setBgmDisclaimerOpen(false)}
              className="px-4 py-2 rounded-lg text-sm font-semibold transition-all"
              style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
            >
              Got it
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelAssemblyConfirmOpen} onOpenChange={(open) => { if (!cancellingAssembly) setCancelAssemblyConfirmOpen(open); }}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Cancel this assembly?</DialogTitle>
            <DialogDescription>
              This will <strong>discard the in-progress assembly</strong> — all intermediate work (transcription, encoded clips, joined / padded / mixed video) will be deleted from storage and you won&apos;t be able to Resume. Your previously assembled video (if any) is kept. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setCancelAssemblyConfirmOpen(false)}
              disabled={cancellingAssembly}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-40"
              style={{ background: "transparent", border: "1px solid var(--bd-card)", color: "var(--c-60)" }}
            >
              Keep
            </button>
            <button
              onClick={cancelAssembly}
              disabled={cancellingAssembly}
              className="px-4 py-2 rounded-lg text-sm font-semibold transition-all disabled:opacity-60"
              style={{ background: "oklch(0.6 0.22 25)", color: "var(--bg-page-2)" }}
            >
              {cancellingAssembly ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Cancelling…
                </span>
              ) : "Yes, cancel"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
