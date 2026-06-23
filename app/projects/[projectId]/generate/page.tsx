"use client";

import { useState, use, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { WizardNav } from "@/components/wizard/WizardNav";
import { useProject } from "@/hooks/useProject";
import { RotateCcw, RefreshCw, ChevronsRight, Wand2, Pencil, Video, ImageIcon } from "lucide-react";
import { ImageSparkle } from "@/components/icons/ImageSparkle";
import { StepCostCard } from "@/components/StepCostCard";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { ModelPicker } from "@/components/ModelPicker";
import useSWR from "swr";
import type { KieModel, Beat } from "@/lib/types";
import type { ApiStatusResult } from "@/app/api/api-status/route";
import { getModelConfig } from "@/lib/kie/imageModels";
import { getVideoModelConfig } from "@/lib/kie/videoModels";
import { removeLongPauses, encodeMp3 } from "@/lib/audio/silenceRemover";

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) return r.json().catch(() => ({})).then((e: { error?: string }) => { throw new Error(e.error ?? `Failed to load (${r.status})`); });
    return r.json().catch(() => ({}));
  });

function isCreditError(raw: string | undefined | null): boolean {
  const msg = (raw ?? "").toLowerCase();
  return msg.includes("credits insufficient")
    || msg.includes("insufficient credits")
    || (msg.includes("insufficient") && (msg.includes("balance") || msg.includes("credit")))
    || msg.includes("quota_exceeded")
    || msg.includes("quota exceeded")
    || msg.includes("credits remaining")
    || msg.includes("credit balance");
}

// True when the error string indicates "this model can't accept your
// request" rather than a transient blip. When this fires, retrying
// the same model is hopeless — the only fix is switching models —
// so we sweep any other queued/rendering beats to failed instead of
// letting them burn through one by one.
function isModelTerminalError(raw: string | undefined | null): boolean {
  const msg = (raw ?? "").toLowerCase();
  return msg.includes("this field is required")
    || msg.includes("invalid model")
    || msg.includes("rejected the request")
    || msg.includes("temporarily paused")
    || msg.includes("video quality cannot be empty")
    || msg.includes("video model rejected");
}

function friendlyError(raw: string | undefined | null): string {
  const msg = (raw ?? "").toLowerCase();
  if (msg.includes("credits insufficient") || msg.includes("insufficient credits") || (msg.includes("insufficient") && (msg.includes("balance") || msg.includes("credit"))))
    return "Insufficient KIE credits — top up your account at kie.ai";
  if (msg.includes("quota_exceeded") || msg.includes("quota exceeded") || msg.includes("credits remaining") || msg.includes("credit balance"))
    return "Insufficient KIE credits — top up your account at kie.ai";
  if (msg.includes("invalid_api_key") || msg.includes("invalid api key") || msg.includes("unauthorized") || (msg.includes("api key") && msg.includes("invalid")))
    return "API key is invalid — go to Settings to update it";
  if (msg.includes("api key") && (msg.includes("missing") || msg.includes("not set") || msg.includes("required")))
    return "API key not set — go to Settings to add it";
  if (msg.includes("internal error") || msg.includes("internal server error") || msg.includes("fail code 500"))
    return "The selected model is temporarily unavailable — try a different one";
  if (msg.includes("temporarily paused") || msg.includes("interface is paused") || msg.includes("model is paused") || msg.includes("paused by kie"))
    return "KIE has temporarily paused this model — try a different one";
  if (msg.includes("this field is required"))
    return "Video model rejected the request — try a different video model";
  if (msg.includes("timed out") || msg.includes("timeout"))
    return "Generation timed out — try a different model";
  if (msg.includes("no task id") || msg.includes("no taskid"))
    return "Failed to queue task — the model may be unavailable, try another";
  if (msg.includes("no url") || msg.includes("no image url") || msg.includes("completed but no url"))
    return "Image was generated but could not be retrieved — try again";
  if (msg.includes("rate limit") || msg.includes("too many requests"))
    return "Too many requests — wait a moment and try again";
  if (raw && raw.length > 0) return raw;
  return "Something went wrong — please try again";
}

interface PageProps {
  params: { projectId: string };
}

function VoiceOption({ model, selected, onSelect, isPlaying, onPlayToggle }: {
  model: KieModel; selected: boolean; onSelect: () => void;
  isPlaying: boolean; onPlayToggle: (id: string | null) => void;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!isPlaying && audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
  }, [isPlaying]);

  useEffect(() => () => { audioRef.current?.pause(); }, []);

  function togglePreview(e: React.MouseEvent) {
    e.stopPropagation();
    if (!model.previewUrl) return;
    if (isPlaying) {
      onPlayToggle(null);
    } else {
      onSelect(); // previewing a voice should also select it
      const audio = new Audio(model.previewUrl);
      audioRef.current = audio;
      audio.onended = () => onPlayToggle(null);
      audio.onerror = () => onPlayToggle(null);
      audio.play().catch(() => onPlayToggle(null));
      onPlayToggle(model.id);
    }
  }

  return (
    <div
      role="button"
      onClick={onSelect}
      className="cursor-pointer p-3 rounded-xl transition-all select-none"
      style={selected ? {
        background: "oklch(0.72 0.25 285 / 0.1)",
        border: "1px solid oklch(0.72 0.25 285 / 0.3)",
        color: "var(--c-90)",
      } : {
        background: "var(--bg-input)",
        border: "1px solid var(--bd-7)",
        color: "var(--c-60)",
      }}
    >
      <div className="flex items-center gap-2">
        <p className="font-medium text-xs flex-1 truncate">{model.name}</p>
        {model.previewUrl && (
          <button
            onClick={togglePreview}
            title={isPlaying ? "Stop preview" : "Preview voice"}
            className="w-6 h-6 rounded flex items-center justify-center shrink-0 transition-colors"
            style={{
              background: isPlaying ? "oklch(0.72 0.25 285 / 0.15)" : "oklch(0.2 0 0)",
              color: isPlaying ? "oklch(0.72 0.25 285)" : "var(--c-45)",
              border: "1px solid var(--bd-10)",
            }}
          >
            {isPlaying ? (
              <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor">
                <rect x="0.5" y="0" width="2.5" height="8" rx="0.5" />
                <rect x="5" y="0" width="2.5" height="8" rx="0.5" />
              </svg>
            ) : (
              <svg width="7" height="9" viewBox="0 0 7 9" fill="currentColor">
                <path d="M0 0.5L7 4.5L0 8.5V0.5Z" />
              </svg>
            )}
          </button>
        )}
      </div>
      {model.tags && model.tags.length > 0 && (
        <div className="flex gap-1 mt-1.5 flex-wrap">
          {model.tags.map((tag) => (
            <span key={tag} className="px-1.5 py-0.5 rounded text-xs"
              style={{ background: "var(--bg-track)", color: "var(--c-45)" }}>
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function SectionHeader({ icon, title, subtitle }: { icon: React.ReactNode; title: string; subtitle: string }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <div className="w-9 h-9 rounded-xl flex items-center justify-center text-base"
        style={{ background: "oklch(0.72 0.25 285 / 0.1)", color: "oklch(0.72 0.25 285)", border: "1px solid oklch(0.72 0.25 285 / 0.2)" }}>
        {icon}
      </div>
      <div>
        <p className="font-semibold text-sm">{title}</p>
        <p className="text-xs" style={{ color: "var(--c-45)" }}>{subtitle}</p>
      </div>
    </div>
  );
}

// Per-track overflow menu shown next to each voiceover's audio player.
// Browser-native audio controls have their own ⋮ dropdown (with their
// own download / playback rate / picture-in-picture entries) that we
// can't customize — this is a parallel menu under our control with
// Download (a real download link) and Delete (opens the confirmation
// dialog at the page level). Click-outside dismisses; Escape closes.
function VoiceoverTrackMenu({
  url,
  downloadName,
  onRequestDelete,
}: {
  url: string;
  downloadName: string;
  onRequestDelete: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Track options"
        aria-haspopup="menu"
        aria-expanded={open}
        className="w-7 h-7 rounded-lg flex items-center justify-center text-base leading-none hover:opacity-90 transition-opacity"
        style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-7)", color: "var(--c-60)" }}
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-[calc(100%+4px)] z-20 min-w-[160px] rounded-xl p-1 shadow-lg"
          style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}
        >
          <a
            href={url}
            download={downloadName}
            onClick={() => setOpen(false)}
            role="menuitem"
            className="block w-full text-left px-3 py-2 rounded-lg text-xs hover:opacity-90 transition-opacity"
            style={{ color: "var(--c-60)" }}
          >
            ↓ Download
          </a>
          <button
            type="button"
            onClick={() => { setOpen(false); onRequestDelete(); }}
            role="menuitem"
            className="block w-full text-left px-3 py-2 rounded-lg text-xs hover:opacity-90 transition-opacity"
            style={{ color: "oklch(0.7 0.22 25)" }}
          >
            🗑 Delete voiceover
          </button>
        </div>
      )}
    </div>
  );
}

function ProgressBar({ value, total }: { value: number; total: number }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between text-xs" style={{ color: "var(--c-45)" }}>
        <span>{value} / {total}</span>
        <span>{pct}%</span>
      </div>
      <div className="h-1 rounded-full overflow-hidden" style={{ background: "var(--bg-track)" }}>
        <div className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, background: "linear-gradient(90deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))" }} />
      </div>
    </div>
  );
}

export default function GeneratePage({ params }: PageProps) {
  const { projectId } = params;
  const router = useRouter();
  const { project, mutate } = useProject(projectId);

  const { data: ttsModels, error: ttsError } = useSWR<KieModel[]>("/api/kie/models?type=tts", fetcher);
  const { data: imageModels } = useSWR<KieModel[]>("/api/kie/models?type=image", fetcher);
  const { data: videoModels } = useSWR<KieModel[]>("/api/kie/models?type=video", fetcher);
  // KIE balance for the proactive credit display + warning banner.
  // Refreshes every 30s so the number stays roughly current without
  // hammering the credit endpoint.
  const { data: apiStatus, mutate: mutateApiStatus } = useSWR<ApiStatusResult>(
    "/api/api-status",
    fetcher,
    { revalidateOnFocus: false, refreshInterval: 30_000 }
  );

  const [playingVoiceId, setPlayingVoiceId] = useState<string | null>(null);
  const [selectedTtsModel, setSelectedTtsModel] = useState<string | null>(null);
  const [selectedImageModel, setSelectedImageModel] = useState<string | null>(null);
  const [selectedAspectRatio, setSelectedAspectRatio] = useState("16:9");
  const [selectedResolution, setSelectedResolution] = useState<string | null>(null);
  const [selectedVideoModel, setSelectedVideoModel] = useState<string | null>(null);
  const [selectedVideoAspectRatio, setSelectedVideoAspectRatio] = useState("16:9");
  const [selectedDuration, setSelectedDuration] = useState<string | number | null>(null);
  const [voiceTab, setVoiceTab] = useState<"female" | "male">("female");

  const initialTtsSelected = useRef(false);

  const [navigating, setNavigating] = useState(false);
  const [generatingTts, setGeneratingTts] = useState(false);
  const [ttsProgress, setTtsProgress] = useState<{ current: number; total: number } | null>(null);
  const [ttsStatusMsg, setTtsStatusMsg] = useState<string>("");
  const [removingPauses, setRemovingPauses] = useState(false);
  const [removePausesStatus, setRemovePausesStatus] = useState("");
  const [generatingImages, setGeneratingImages] = useState(false);
  const [stoppingImages, setStoppingImages] = useState(false);
  // The latest error message from the current image-gen run. We
  // overwrite this on every new failure so the banner only ever
  // shows ONE error — whichever was most recent. Cleared at the
  // start of every new run.
  const [imageRunError, setImageRunError] = useState<string | null>(null);
  // Same shape for the video side. Captures any action-level failure
  // (queue rejection, resume failure, single-regen rejection, etc.)
  // so the section banner above the Queue button is the single home
  // for video-failure context — no more toasts that scroll off-screen.
  const [videoRunError, setVideoRunError] = useState<string | null>(null);
  // Refs to scroll the error banners into view once they appear so
  // the user actually sees the failure summary instead of having to
  // scan the page for it.
  const imageErrorBannerRef = useRef<HTMLDivElement | null>(null);
  const videoErrorBannerRef = useRef<HTMLDivElement | null>(null);
  // Latch the "was visible" state so we only scroll-into-view once per
  // banner appearance (not on every re-render while it's open).
  const imageBannerShown = useRef(false);
  const videoBannerShown = useRef(false);

  // Wipe accumulated error UI state before any new user-initiated
  // generation action. Without this, stale errors from a previous
  // attempt linger on the banner even after the user has picked a
  // different model and clicked Generate / Queue / Regenerate —
  // making it look like the new action already failed.
  function resetImageErrorBanner() {
    setImageRunError(null);
    imageBannerShown.current = false;
  }
  function resetVideoErrorBannerLocal() {
    // Local-only reset: clears React state for the banner without
    // touching the DB. Used by single-beat actions (regen), where
    // we don't want to wipe other failed beats' video_error / status
    // just because the user retried one of them. The acted-on beat
    // gets its own video_error cleared by the queue route's UPDATE.
    setVideoRunError(null);
    videoBannerShown.current = false;
  }

  function resetVideoErrorBanner() {
    setVideoRunError(null);
    videoBannerShown.current = false;
    // Project-wide reset: clears video_error on every beat and flips
    // failed beats' status back to null so the banner fully resets.
    // Use this only for bulk actions (queue / resume) where the user
    // is sweeping across multiple beats and a clean slate is what
    // they want. After the route resolves, re-mutate SWR so the UI
    // redraws — without this the banner would linger for up to the
    // SWR refresh interval.
    void (async () => {
      try {
        await fetch("/api/generate/videos/clear-errors", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId }),
        });
        await mutate();
      } catch { /* best-effort — banner UI already cleared via state */ }
    })();
  }
  // Latched flag: true after the user clicks Stop, false while a new
  // run is starting. Lets us suppress the "X images didn't generate"
  // partial-completion warning when the gap is intentional rather
  // than a model failure.
  const [userStoppedImages, setUserStoppedImages] = useState(false);
  // AbortController for the image generation loop. Halts submission
  // between batches (preventing further KIE charges on unsubmitted
  // beats) and stops the local poll loop. Already-submitted beats keep
  // running on KIE; their results land via the page-resume effect, the
  // cron, or the webhook — no work or money is lost.
  const imagesAbortRef = useRef<AbortController | null>(null);
  const [queuingVideos, setQueuingVideos] = useState(false);
  const [pausingVideos, setPausingVideos] = useState(false);
  const [resumingVideos, setResumingVideos] = useState(false);
  const [imagesProgress, setImagesProgress] = useState(0);
  // Pending URLs are only set during active generation; otherwise fall back to DB values via project
  const [pendingTtsUrl, setPendingTtsUrl] = useState<string | null>(null);
  const [pendingTtsCleanedUrl, setPendingTtsCleanedUrl] = useState<string | null>(null);
  const [cleanedUrlInvalidated, setCleanedUrlInvalidated] = useState(false);
  // Delete-voiceover flow. Click the trash icon → confirm dialog →
  // server PATCH clears the project's tts_url / tts_cleaned_url /
  // tts_script_hash / tts_voice_id and removes the R2 objects. Local
  // pending* state is reset alongside so the audio elements unmount
  // without waiting for the SWR refetch.
  const [deleteVoiceoverConfirmOpen, setDeleteVoiceoverConfirmOpen] = useState(false);
  // Regenerate All confirms before firing because it wipes every
  // existing image on the project — paid work the user might lose
  // by mis-clicking the secondary button.
  const [regenerateAllConfirmOpen, setRegenerateAllConfirmOpen] = useState(false);
  // Submitting flags for modal action buttons. Each holds the modal
  // open with a visible spinner while the click handler is in flight —
  // long-running image / regen work continues in the background after
  // the modal closes, but the brief in-modal feedback confirms the
  // click before dismissing. Matches the project's modal-loading rule.
  const [regenerateAllSubmitting, setRegenerateAllSubmitting] = useState(false);
  const [editPromptSubmitting, setEditPromptSubmitting] = useState(false);
  const [deletingVoiceover, setDeletingVoiceover] = useState(false);

  // Per-beat video regenerate flow. The icon overlay on each generated
  // video clip opens this modal with the beat number stashed; confirming
  // hits /api/generate/videos for just that one beat. The route already
  // nulls video_url/video_status/video_job_id/video_error when it accepts
  // a new submission, so we don't need a separate clear pass first — the
  // old R2 file becomes an orphan (next regen overwrites its key with a
  // fresh upload, so disk usage stays bounded).
  const [regeneratingVideo, setRegeneratingVideo] = useState(false);
  // Single-beat video regen — fires immediately from the per-tile
  // overlay button. The previous version routed through a confirm
  // modal; we dropped the modal so the overlay click is the action.
  async function regenerateVideoBeat(beatNumber: number) {
    // SINGLE-BEAT path: clear ONLY the React banner state. Do not
    // touch the DB sweep — other failed beats should keep their
    // error context until the user explicitly retries them too.
    resetVideoErrorBannerLocal();
    const beat = beats.find((b) => b.beatNumber === beatNumber);
    if (!beat || !beat.videoPrompt || !beat.imageUrl) {
      setVideoRunError("Cannot regenerate — beat is missing its prompt or source image.");
      return;
    }
    if (!selectedVideoModel) {
      setVideoRunError("Pick a video model first.");
      return;
    }
    setRegeneratingVideo(true);
    try {
      const res = await fetch("/api/generate/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          beats: [{ beatNumber: beat.beatNumber, videoPrompt: beat.videoPrompt, imageUrl: beat.imageUrl }],
          modelId: selectedVideoModel,
          aspectRatio: selectedVideoAspectRatio,
          ...(selectedDuration !== null ? { duration: selectedDuration } : {}),
        }),
      });
      const data = await res.json().catch(() => ({})) as { submitted?: number; failures?: { beatNumber: number; error: string }[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Request failed (HTTP ${res.status})`);
      if (data.failures?.length) {
        setVideoRunError(friendlyError(data.failures[0].error));
      } else {
        toast.success(`Beat ${beat.beatNumber} re-queued`);
        setVideosSubmitted(true);
      }
    } catch (err) {
      setVideoRunError(friendlyError(err instanceof Error ? err.message : null));
    } finally {
      setRegeneratingVideo(false);
    }
  }
  async function deleteVoiceover() {
    setDeletingVoiceover(true);
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clear_voiceover: true }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to delete voiceover");
      }
      setPendingTtsUrl(null);
      setPendingTtsCleanedUrl(null);
      setCleanedUrlInvalidated(true);
      setDeleteVoiceoverConfirmOpen(false);
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete voiceover");
    } finally {
      setDeletingVoiceover(false);
    }
  }
  const [videosSubmitted, setVideosSubmitted] = useState(false);
  const [regenBeats, setRegenBeats] = useState<Set<number>>(new Set());
  const [clearingImages, setClearingImages] = useState(false);
  // Sticky "KIE has no credits" banner. Set when any submission fails
  // with an insufficient-credit error and cleared on the next
  // successful submit or balance refresh. We can't rely on the toast
  // alone because it disappears in 4s — the user can miss it on a
  // long-running job.
  const [outOfCredits, setOutOfCredits] = useState(false);
  const [hoveredImageBeat, setHoveredImageBeat] = useState<Beat | null>(null);
  // Edit-prompt modal: when set, opens a dialog letting the user
  // tweak the beat's image prompt before kicking off a regen. The
  // new prompt is persisted by the regenerate route so Prompt
  // Studio reflects the change.
  const [editPromptBeat, setEditPromptBeat] = useState<Beat | null>(null);
  const [editedPrompt, setEditedPrompt] = useState("");
  // Mobile-only tap-to-preview: replaces the desktop hover preview on
  // touch devices. Tile tap opens a centered modal showing the asset
  // + beat number + prompt; backdrop tap dismisses.
  const [previewBeat, setPreviewBeat] = useState<{ beat: Beat; type: "image" | "video" } | null>(null);
  // Where the hover preview should appear, computed from the
  // thumbnail's bounding rect on hover. We anchor in viewport
  // coordinates (position: fixed) so scrolling the page or the
  // grid doesn't drag the preview around. The mouseleave that
  // would fire on scroll also clears the anchor, so this is safe.
  const [hoveredImageAnchor, setHoveredImageAnchor] = useState<{ top: number; left: number } | null>(null);
  const [hoveredVideoBeat, setHoveredVideoBeat] = useState<Beat | null>(null);
  // Same anchoring model the image preview uses — computed from the
  // hovered thumbnail's bounding rect on enter so the preview floats
  // next to the actual tile instead of fixed at the bottom-right
  // corner of the viewport.
  const [hoveredVideoAnchor, setHoveredVideoAnchor] = useState<{ top: number; left: number } | null>(null);
  const videoHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const beats: Beat[] = project?.beats ?? [];
  const script: string = project?.script ?? "";
  const totalBeats = beats.length;
  const generatedImages = beats.filter((b) => b.imageUrl).length;
  const generatedVideos = beats.filter((b) => b.videoUrl).length;
  const videoBeats = beats.filter((b) => b.videoPrompt).length;
  // A beat that holds a videoUrl is logically done, even if a stale
  // "failed" status is still on the row from an earlier retry — the
  // worker doesn't clear video_url when writing a failure, so we have
  // to gate failure on "no URL produced" here.
  const failedVideos = beats.filter((b) => b.videoPrompt && b.videoStatus === "failed" && !b.videoUrl).length;
  const pendingVideos = beats.filter((b) => b.videoPrompt && !b.videoUrl).length;
  // Beats that are actually queue-able right now: have a video prompt,
  // have a source image (image-to-video models need it), and no clip
  // yet. We let users queue partials as images trickle in, so this is
  // usually smaller than pendingVideos in the middle of an image run.
  const pendingVideosWithImages = beats.filter((b) => b.videoPrompt && b.imageUrl && !b.videoUrl).length;
  const queuedVideos = beats.filter((b) => b.videoStatus === "queued").length;
  const pausedVideos = beats.filter((b) => b.videoStatus === "paused").length;
  // Video clips need an image to motion-render off of. Previously this
  // gated on every beat having an image, so users had to wait for the
  // whole image batch to finish before they could start any video
  // work. Now we unlock as soon as at least one image is done — the
  // queue handler only submits beats that have an image, so partials
  // are safe.
  const imagesReady = generatedImages > 0;
  const videosBlockedByImages = !imagesReady;
  const videoBlockReason = videosBlockedByImages
    ? `Waiting on first image — ${generatedImages}/${totalBeats} done`
    : undefined;

  // Derive display URLs from DB data; use pending state only during active operations
  const ttsUrl = generatingTts ? null : (pendingTtsUrl ?? project?.tts_url ?? null);
  const ttsCleanedUrl = removingPauses || cleanedUrlInvalidated ? null : (pendingTtsCleanedUrl ?? project?.tts_cleaned_url ?? null);

  // Hash the current script in the browser so we can compare it against
  // the hash stored when this voiceover was generated. If they differ,
  // the saved tts_url is narration for an older version of the script
  // and the user should be warned before they continue.
  const [currentScriptHash, setCurrentScriptHash] = useState<string | null>(null);
  useEffect(() => {
    if (!script) { setCurrentScriptHash(null); return; }
    let cancelled = false;
    (async () => {
      const buf = new TextEncoder().encode(script);
      const digest = await crypto.subtle.digest("SHA-256", buf);
      const hex = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
      if (!cancelled) setCurrentScriptHash(hex);
    })();
    return () => { cancelled = true; };
  }, [script]);
  const ttsStale = !!ttsUrl
    && !generatingTts
    && !!project?.tts_script_hash
    && !!currentScriptHash
    && project.tts_script_hash !== currentScriptHash;

  // Beats are the parent of the image/video assets shown below. If the
  // script changed after the prompts step ran, both the images and the
  // motion clips were generated against an out-of-date beat list and
  // need to be regenerated upstream (Prompt Studio → Regenerate) before
  // images/videos can match the current script again.
  const videosInFlight = queuingVideos
    || beats.some((b) => b.videoStatus === "queued" || b.videoStatus === "submitting" || b.videoStatus === "rendering");
  const beatsStale = beats.length > 0
    && !generatingImages
    && !videosInFlight
    && !!project?.prompts_script_hash
    && !!currentScriptHash
    && project.prompts_script_hash !== currentScriptHash;

  useEffect(() => {
    if (!generatingImages && project?.images_progress) setImagesProgress(project.images_progress);
  }, [project?.images_progress, generatingImages]);

  // Auto-clear the sticky out-of-credits banner once the refreshed
  // balance shows positive credits again. Avoids needing the user to
  // dismiss it manually after they top up.
  useEffect(() => {
    const c = apiStatus?.kie?.credits;
    if (outOfCredits && typeof c === "number" && c > 0) setOutOfCredits(false);
  }, [apiStatus?.kie?.credits, outOfCredits]);

  // Resume polling for any image tasks that were in flight when the
  // page was last closed. Without this, taskIds only lived in the
  // generateImages() local state — a refresh / tab close / network
  // glitch left the beat marked "generating" with no way to map the
  // KIE result back to it. resumedRef gates the effect so we don't
  // re-fire when beats reload after each poll.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current) return;
    if (generatingImages) return; // active local poller already running
    if (!project?.beats) return;
    const inflight = (project.beats as Beat[]).filter(
      (b) => b.imageStatus === "generating" && b.imageTaskId && !b.imageUrl
    );
    if (inflight.length === 0) return;
    resumedRef.current = true;

    void (async () => {
      const remaining = inflight.map((b) => ({
        beatNumber: b.beatNumber,
        taskId: b.imageTaskId as string,
        modelId: b.imageModelId ?? selectedImageModel ?? "",
      }));
      const MAX_POLLS = 50;
      for (let attempt = 0; attempt < MAX_POLLS && remaining.length > 0; attempt++) {
        await new Promise((r) => setTimeout(r, 3000));
        const results = await Promise.allSettled(
          remaining.map(async ({ beatNumber, taskId, modelId }) => {
            const res = await fetch("/api/generate/images/poll", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ projectId, beatNumber, taskId, modelId }),
            });
            const data = await res.json().catch(() => ({})) as { status?: string };
            return { beatNumber, status: !res.ok ? "error" : (data.status ?? "pending") };
          })
        );
        const toRemove: number[] = [];
        for (let i = 0; i < results.length; i++) {
          if (results[i].status === "fulfilled") {
            const { status } = (results[i] as PromiseFulfilledResult<{ beatNumber: number; status: string }>).value;
            if (status === "done" || status === "failed" || status === "error") toRemove.push(i);
          }
        }
        for (let i = toRemove.length - 1; i >= 0; i--) remaining.splice(toRemove[i], 1);
        await mutate();
      }
    })();
  }, [project?.beats, projectId, mutate, generatingImages, selectedImageModel]);

  useEffect(() => {
    if (ttsModels?.length && !initialTtsSelected.current) {
      initialTtsSelected.current = true;
      setSelectedTtsModel(ttsModels[0].id);
    }
  }, [ttsModels]);
  // When the user switches the Male/Female tab and the currently-selected
  // voice is in the other gender, snap selection to the first voice of the
  // visible tab so they don't end up generating with a voice they can't see.
  useEffect(() => {
    if (!ttsModels) return;
    const currentInTab = ttsModels.some((m) => m.id === selectedTtsModel && m.tags?.[0]?.toLowerCase() === voiceTab);
    if (currentInTab) return;
    const firstInTab = ttsModels.find((m) => m.tags?.[0]?.toLowerCase() === voiceTab);
    if (firstInTab) setSelectedTtsModel(firstInTab.id);
  }, [voiceTab, ttsModels]); // eslint-disable-line react-hooks/exhaustive-deps
  // Initial image-model pick: prefer the user's last selection from
  // localStorage (across projects, across refreshes) when it's still
  // in the currently-available model list, otherwise fall through to
  // the first model. Never writes to the project row — the model only
  // makes it to the DB at queue/submission time, so each user's local
  // preference stays scoped to their browser.
  useEffect(() => {
    if (!imageModels?.length || selectedImageModel) return;
    let preferred: string | null = null;
    if (typeof window !== "undefined") {
      try {
        const saved = window.localStorage.getItem("heclus-preferred-image-model");
        if (saved && imageModels.some((m) => m.id === saved)) preferred = saved;
      } catch { /* localStorage disabled — fall through to first model */ }
    }
    setSelectedImageModel(preferred ?? imageModels[0].id);
  }, [imageModels]); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist subsequent image-model changes to localStorage so the
  // next mount of this page (any project, same browser) picks back
  // up where the user left off. No DB write involved — this is
  // pure browser-local UX state.
  useEffect(() => {
    if (!selectedImageModel || typeof window === "undefined") return;
    try { window.localStorage.setItem("heclus-preferred-image-model", selectedImageModel); } catch { /* ignore */ }
  }, [selectedImageModel]);

  useEffect(() => {
    if (!selectedImageModel) return;
    const config = getModelConfig(selectedImageModel);
    if (!config.aspectRatios.includes(selectedAspectRatio)) {
      setSelectedAspectRatio(config.aspectRatios[0]);
    }
    if (!config.resolutions) {
      setSelectedResolution(null);
    } else if (!selectedResolution || !config.resolutions.includes(selectedResolution)) {
      setSelectedResolution(config.resolutions[0]);
    }
  }, [selectedImageModel]); // eslint-disable-line react-hooks/exhaustive-deps
  // Same persistence pattern as image model — prefer last pick from
  // localStorage when still valid, else first available. Selection
  // never updates the project DB on its own; it only writes when the
  // user actually queues a video gen.
  useEffect(() => {
    if (!videoModels?.length || selectedVideoModel) return;
    let preferred: string | null = null;
    if (typeof window !== "undefined") {
      try {
        const saved = window.localStorage.getItem("heclus-preferred-video-model");
        if (saved && videoModels.some((m) => m.id === saved)) preferred = saved;
      } catch { /* ignore */ }
    }
    setSelectedVideoModel(preferred ?? videoModels[0].id);
  }, [videoModels]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!selectedVideoModel || typeof window === "undefined") return;
    try { window.localStorage.setItem("heclus-preferred-video-model", selectedVideoModel); } catch { /* ignore */ }
  }, [selectedVideoModel]);

  // Scroll the image error banner into view the first render it
  // becomes visible. Latched via imageBannerShown.current so the
  // scroll only happens once per appearance — not on every state
  // change while the banner is up.
  useEffect(() => {
    const banner = imageErrorBannerRef.current;
    if (banner && !imageBannerShown.current) {
      imageBannerShown.current = true;
      banner.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (!banner) {
      imageBannerShown.current = false;
    }
  });

  useEffect(() => {
    const banner = videoErrorBannerRef.current;
    if (banner && !videoBannerShown.current) {
      videoBannerShown.current = true;
      banner.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (!banner) {
      videoBannerShown.current = false;
    }
  });

  useEffect(() => {
    if (!selectedVideoModel) return;
    const config = getVideoModelConfig(selectedVideoModel);
    if (config.durations.length === 0) {
      setSelectedDuration(null);
    } else {
      setSelectedDuration(config.durations[0].value);
    }
    if (!config.aspectRatios.includes(selectedVideoAspectRatio)) {
      setSelectedVideoAspectRatio(config.aspectRatios[0]);
    }
  }, [selectedVideoModel]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasActiveVideos = beats.some((b) =>
    b.videoStatus === "queued" || b.videoStatus === "submitting" || b.videoStatus === "rendering");

  useEffect(() => {
    if (hasActiveVideos && !videosSubmitted) setVideosSubmitted(true);
  }, [hasActiveVideos]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!videosSubmitted) return;
    let lastError: string | null = null;
    let cancelDispatched = false;
    const poll = async () => {
      const res = await fetch(`/api/generate/videos/poll?projectId=${projectId}`);
      const data = await res.json().catch(() => ({})) as { pending?: number; firstError?: string | null };
      if (data.firstError && data.firstError !== lastError) {
        lastError = data.firstError;
        // Push into the section banner — single source of truth for
        // video failure context, no more disappearing toasts.
        setVideoRunError(friendlyError(data.firstError));
        // Terminal "the model rejected this" errors will keep failing
        // for every remaining queued/rendering beat with the same
        // model. Sweep them all to failed in one shot so the worker
        // stops burning attempts and the UI's "Rendering" badge
        // doesn't linger on beats that are guaranteed to fail next.
        if (!cancelDispatched && isModelTerminalError(data.firstError)) {
          cancelDispatched = true;
          try {
            await fetch("/api/generate/videos/cancel-pending", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ projectId, errorMessage: data.firstError }),
            });
          } catch { /* best-effort — next poll will reflect whatever state we land in */ }
        }
      }
      await mutate();
    };
    poll();
    const id = setInterval(poll, 4000);
    return () => clearInterval(id);
  }, [videosSubmitted, projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function generateVoiceover(voiceId = selectedTtsModel) {
    if (!voiceId) return;
    // Force a fresh fetch to ensure we have the latest script, not a stale SWR cache
    const fresh = await mutate();
    const latestScript = fresh?.script ?? script;
    if (!latestScript) return;
    setGeneratingTts(true);
    setPendingTtsUrl(null);
    setPendingTtsCleanedUrl(null);
    setCleanedUrlInvalidated(true);
    setTtsProgress(null);
    setTtsStatusMsg("Starting...");
    try {
      const res = await fetch("/api/generate/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, script: latestScript, voiceId }),
      });
      if (!res.ok || !res.body) throw new Error("Failed to start TTS");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      // Track whether the stream sent a terminal event. Without this,
      // a function timeout that drops the connection mid-stream looks
      // like a silent success — reader exits, no toast, no result.
      let receivedTerminal = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let event: { type?: string; current?: number; total?: number; message?: string; url?: string };
          try {
            event = JSON.parse(line.slice(6));
          } catch {
            continue; // skip partial / malformed chunk
          }
          if (event.type === "progress") {
            setTtsProgress({ current: event.current ?? 0, total: event.total ?? 1 });
            setTtsStatusMsg(`Generating part ${(event.current ?? 0) + 1} of ${event.total ?? 1}...`);
          } else if (event.type === "status") {
            setTtsStatusMsg(event.message ?? "");
          } else if (event.type === "done") {
            receivedTerminal = true;
            if (event.url) setPendingTtsUrl(event.url);
            toast.success("Voiceover generated!");
          } else if (event.type === "error") {
            receivedTerminal = true;
            throw new Error(event.message ?? "Voiceover generation failed");
          }
        }
      }
      if (!receivedTerminal) {
        throw new Error("Voiceover generation ended unexpectedly — the connection closed before completing. Try again.");
      }
    } catch (err) {
      toast.error(friendlyError(err instanceof Error ? err.message : null));
    } finally {
      setGeneratingTts(false);
      setTtsProgress(null);
      setTtsStatusMsg("");
    }
  }

  async function removePauses() {
    if (!ttsUrl || removingPauses) return;
    setRemovingPauses(true);
    setPendingTtsCleanedUrl(null);
    setRemovePausesStatus("Fetching audio...");
    try {
      const res = await fetch(ttsUrl);
      if (!res.ok) throw new Error("Failed to fetch audio");
      const audioBytes = await res.arrayBuffer();

      setRemovePausesStatus("Decoding audio...");
      const ctx = new AudioContext();
      const audioBuffer = await ctx.decodeAudioData(audioBytes);
      ctx.close();

      setRemovePausesStatus("Removing pauses...");
      const { channels, sampleRate, originalDuration, newDuration } = await removeLongPauses(audioBuffer);

      setRemovePausesStatus("Encoding audio...");
      const mp3Bytes = await encodeMp3(channels, sampleRate);

      setRemovePausesStatus("Preparing upload...");
      // Two-step upload: get a presigned R2 URL, PUT the MP3 directly to
      // R2 (bypasses Vercel's 4.5MB function body limit), then ping the
      // route to update the DB row. Required for long voiceovers.
      const presignRes = await fetch(`/api/generate/tts/clean?projectId=${projectId}`, { method: "POST" });
      if (!presignRes.ok) {
        const err = await presignRes.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to prepare upload");
      }
      const { uploadUrl, publicUrl: uploadedUrl } = await presignRes.json() as { uploadUrl: string; publicUrl: string };

      setRemovePausesStatus("Uploading...");
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        body: mp3Bytes,
        headers: { "Content-Type": "audio/mpeg" },
      });
      if (!putRes.ok) throw new Error(`Upload failed (HTTP ${putRes.status})`);

      setRemovePausesStatus("Saving...");
      const finalizeRes = await fetch(`/api/generate/tts/clean?projectId=${projectId}&finalize=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ publicUrl: uploadedUrl }),
      });
      if (!finalizeRes.ok) {
        const err = await finalizeRes.json().catch(() => ({})) as { error?: string };
        throw new Error(err.error ?? "Failed to save trimmed audio");
      }
      const { url } = await finalizeRes.json().catch(() => ({})) as { url?: string };
      if (!url) throw new Error("Upload succeeded but no URL returned");
      setPendingTtsCleanedUrl(url);
      setCleanedUrlInvalidated(false);
      const savedSec = Math.round(originalDuration - newDuration);
      toast.success(savedSec > 0 ? `Removed ${savedSec}s of silence` : "No long pauses found");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove pauses");
    } finally {
      setRemovingPauses(false);
      setRemovePausesStatus("");
    }
  }

  async function generateImages(opts: { mode?: "all" | "remaining" } = {}) {
    if (!selectedImageModel || !beats.length) return;

    // Determine which beats to process:
    // - "remaining" (default when some imageUrls exist): only beats
    //   without an imageUrl. Failed/missing ones get retried; already-
    //   successful images stay intact, user doesn't re-pay for them.
    // - "all" (regenerate): wipe existing images first, then process
    //   every beat. Used when all images succeeded and user wants a
    //   fresh take.
    const targetBeats = opts.mode === "all"
      ? beats
      : beats.filter((b) => !b.imageUrl);

    if (targetBeats.length === 0) return;

    const shouldClear = opts.mode === "all" && generatedImages > 0;

    setGeneratingImages(true);
    setImagesProgress(0);
    // Fresh run — clear the latched "user stopped" flag so the
    // partial-completion warning can fire if this run genuinely
    // ends with failures.
    setUserStoppedImages(false);
    // Fresh run — wipe accumulated errors so the banner only ever
    // reflects this attempt's failures, not stale ones from a
    // previous attempt with a different model.
    resetImageErrorBanner();
    if (shouldClear) setClearingImages(true);
    imagesAbortRef.current = new AbortController();
    const abortSignal = imagesAbortRef.current.signal;
    let successCount = 0;
    try {
      if (shouldClear) {
        await fetch(`/api/projects/${projectId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clear_images: true }),
        });
        setClearingImages(false);
      }

      // Submit beats in batches. KIE's "call frequency too high" 429
      // can fire on sustained submission even at moderate rates, so we
      // keep the batch conservative (4+1500ms = ~2.7 req/s baseline)
      // AND retry per-beat on 429 with backoff. The retry honors
      // Retry-After when present; otherwise it doubles 1s → 2s → 4s.
      // Real (non-rate-limit) errors throw immediately.
      const SUBMIT_BATCH = 4;
      const pending: { beatNumber: number; taskId: string }[] = [];
      let firstSubmitError: string | null = null;

      async function submitOne(beat: Beat): Promise<{ beatNumber: number; taskId: string }> {
        const MAX_RETRIES = 4;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          const res = await fetch("/api/generate/images/submit", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectId,
              beatNumber: beat.beatNumber,
              imagePrompt: beat.imagePrompt,
              modelId: selectedImageModel,
              aspectRatio: selectedAspectRatio,
              ...(selectedResolution ? { resolution: selectedResolution } : {}),
            }),
          });
          if (res.status === 429 && attempt < MAX_RETRIES) {
            const retryAfter = res.headers.get("Retry-After");
            const waitMs = retryAfter && Number.isFinite(Number(retryAfter))
              ? Number(retryAfter) * 1000
              : Math.min(8000, 1000 * 2 ** attempt);
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }
          const data = await res.json().catch(() => ({})) as { taskId?: string; error?: string };
          if (!res.ok || !data.taskId) {
            const errMsg = data.error ?? `HTTP ${res.status}`;
            // Surface KIE credit exhaustion as sticky UI state, not just
            // a transient toast. We also kick the balance fetch so the
            // displayed balance updates without waiting for the 30s
            // refresh interval.
            if (isCreditError(errMsg)) {
              setOutOfCredits(true);
              mutateApiStatus();
            }
            throw new Error(errMsg);
          }
          return { beatNumber: beat.beatNumber, taskId: data.taskId };
        }
        throw new Error(`Rate limited after ${MAX_RETRIES + 1} attempts`);
      }

      for (let i = 0; i < targetBeats.length; i += SUBMIT_BATCH) {
        // Stop check between batches — every unsubmitted beat from
        // here on saves a KIE credit. The four in this iteration are
        // already mid-fetch and will resolve; that's the smallest
        // possible "leak" given the in-flight nature.
        if (abortSignal.aborted) break;
        const batch = targetBeats.slice(i, i + SUBMIT_BATCH);
        const batchResults = await Promise.allSettled(batch.map(submitOne));
        for (const r of batchResults) {
          if (r.status === "fulfilled") pending.push(r.value);
          else {
            const reason = r.reason instanceof Error ? r.reason.message : "Unknown error";
            if (!firstSubmitError) firstSubmitError = reason;
            // Overwrite the banner with the latest error so the user
            // always sees the most recent failure rather than a
            // growing list.
            setImageRunError(friendlyError(reason));
          }
        }
        if (i + SUBMIT_BATCH < targetBeats.length) await new Promise((r) => setTimeout(r, 1500));
      }

      // User stopped before any task submitted — nothing to poll, no
      // error to surface (Stop is an intentional, expected action).
      if (abortSignal.aborted && pending.length === 0) {
        toast.info("Stopped — no images were submitted");
        return;
      }
      if (pending.length === 0) {
        throw new Error(firstSubmitError ?? "unknown error");
      }
      // Partial-submit failures used to fire a yellow toast that
      // duplicated the section banner; the banner now lists every
      // distinct error inline, so the toast is just visual clutter.

      // Poll all pending tasks in parallel every 3s until all complete
      const remaining = [...pending];
      let firstPollError: string | null = null;
      const MAX_POLLS = 50; // ~2.5 min max
      for (let attempt = 0; attempt < MAX_POLLS && remaining.length > 0; attempt++) {
        // Stop also exits the poll loop — the in-flight KIE jobs are
        // already paid for and the cron / webhook / page-resume effect
        // will finish them server-side, so we're not losing work.
        if (abortSignal.aborted) break;
        await new Promise((r) => setTimeout(r, 3000));

        const pollResults = await Promise.allSettled(
          remaining.map(async ({ beatNumber, taskId }) => {
            const res = await fetch("/api/generate/images/poll", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ projectId, beatNumber, taskId, modelId: selectedImageModel }),
            });
            const data = await res.json().catch(() => ({})) as { status?: string; error?: string };
            const status = !res.ok ? "error" : (data.status ?? "pending");
            return { beatNumber, taskId, status, error: data.error };
          })
        );

        const toRemove: number[] = [];
        for (let i = 0; i < pollResults.length; i++) {
          if (pollResults[i].status === "fulfilled") {
            const { status, error } = (pollResults[i] as PromiseFulfilledResult<{ beatNumber: number; taskId: string; status: string; error?: string }>).value;
            if (status === "done") { successCount++; setImagesProgress(successCount); toRemove.push(i); }
            else if (status === "failed" || status === "error") {
              const reason = error ?? "Unknown error";
              if (!firstPollError) firstPollError = reason;
              // Overwrite the banner — only the most recent error
              // ever shows.
              setImageRunError(friendlyError(reason));
              toRemove.push(i);
            }
          }
        }
        for (let i = toRemove.length - 1; i >= 0; i--) remaining.splice(toRemove[i], 1);
      }

      await mutate();
      if (abortSignal.aborted) {
        const inFlight = pending.length - successCount;
        if (inFlight > 0) {
          toast.info(`Stopped — ${successCount}/${pending.length} done, ${inFlight} still finishing in the background`);
        } else {
          toast.info(`Stopped — ${successCount}/${pending.length} done`);
        }
      } else if (successCount === 0) {
        // No per-task error was captured (rare) — fall back to a
        // single derived error so the banner has something to say.
        const reason = firstPollError ?? firstSubmitError ?? "timed out";
        setImageRunError((prev) => prev ?? friendlyError(reason));
      } else if (successCount < targetBeats.length) {
        // Partial success — banner already shows the latest error.
      } else {
        toast.success(`${successCount}/${targetBeats.length} images generated`);
      }
    } catch (err) {
      // Abort errors are intentional Stop clicks — silenced by the
      // aborted-branch above, so we only land here on real failures.
      // Surface the error in the section banner instead of toasting.
      if (!abortSignal.aborted) {
        setImageRunError(friendlyError(err instanceof Error ? err.message : null));
      }
    } finally {
      setGeneratingImages(false);
      setClearingImages(false);
      setStoppingImages(false);
      imagesAbortRef.current = null;
    }
  }

  // Stops the image submission loop immediately. Beats already
  // submitted continue running on KIE and land via webhook / cron /
  // page-resume polling — only unsubmitted ones save us money.
  async function handleStopImages() {
    if (!generatingImages || stoppingImages) return;
    setStoppingImages(true);
    // Mark this as a user-initiated halt so the partial-completion
    // banner ("X images didn't generate on …") stays hidden — the
    // gap is intentional, not a model failure to scold the user about.
    setUserStoppedImages(true);
    if (imagesAbortRef.current) {
      try { imagesAbortRef.current.abort(); } catch { /* ignore */ }
    }
  }

  async function regenerateImage(beat: Beat, promptOverride?: string) {
    if (!selectedImageModel) return;
    const promptToUse = promptOverride ?? beat.imagePrompt;
    // New regen → clear the section banner so the user sees a clean
    // slate for this attempt, not stale errors from a previous run.
    resetImageErrorBanner();
    setRegenBeats((prev) => new Set(prev).add(beat.beatNumber));
    try {
      // Single synchronous call to the regenerate route. The server
      // runs the whole flow (submit → poll KIE → upload → update DB
      // → delete previous) and returns the new image URL when done.
      // No client-side polling, no webhook race, no spinner
      // gymnastics — when this resolves, the DB is updated and
      // mutate() pulls the new URL into SWR.
      const res = await fetch("/api/generate/images/regenerate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          beatNumber: beat.beatNumber,
          imagePrompt: promptToUse,
          modelId: selectedImageModel,
          aspectRatio: selectedAspectRatio,
          ...(selectedResolution ? { resolution: selectedResolution } : {}),
        }),
      });
      const data = await res.json().catch(() => ({})) as { ok?: boolean; url?: string; error?: string };
      if (!res.ok) throw new Error(data.error ?? "Regenerate failed");
      toast.success(`Beat ${beat.beatNumber} regenerated`);
      await mutate();
    } catch (err) {
      toast.error(friendlyError(err instanceof Error ? err.message : null));
    } finally {
      setRegenBeats((prev) => { const next = new Set(prev); next.delete(beat.beatNumber); return next; });
    }
  }

  async function pauseVideos() {
    if (pausingVideos) return;
    setPausingVideos(true);
    try {
      const res = await fetch("/api/generate/videos/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      const data = await res.json().catch(() => ({})) as { paused?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Pause failed (HTTP ${res.status})`);
      toast.success(`Paused ${data.paused ?? 0} pending clips`);
      await mutate();
    } catch (err) {
      setVideoRunError(friendlyError(err instanceof Error ? err.message : "Pause failed"));
    } finally {
      setPausingVideos(false);
    }
  }

  async function resumeVideos() {
    if (!selectedVideoModel || resumingVideos) return;
    resetVideoErrorBanner();
    setResumingVideos(true);
    try {
      const res = await fetch("/api/generate/videos/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          modelId: selectedVideoModel,
          aspectRatio: selectedVideoAspectRatio,
          ...(selectedDuration !== null ? { duration: selectedDuration } : {}),
        }),
      });
      const data = await res.json().catch(() => ({})) as { resumed?: number; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Resume failed (HTTP ${res.status})`);
      toast.success(`Resumed ${data.resumed ?? 0} clips`);
      setVideosSubmitted(true);
      await mutate();
    } catch (err) {
      setVideoRunError(friendlyError(err instanceof Error ? err.message : "Resume failed"));
    } finally {
      setResumingVideos(false);
    }
  }

  async function queueVideos(mode: "all" | "failed" = "all") {
    if (!selectedVideoModel || !beats.length) return;
    resetVideoErrorBanner();
    setQueuingVideos(true);
    try {
      // "all" means everything that still needs a video (no URL yet),
      // not literally every beat — re-submitting a done beat would wipe
      // its video_url on the server. "failed" only retries failures.
      // imageUrl is required: image-to-video models won't accept a beat
      // without a source frame. Beats whose images are still rendering
      // are skipped now and become eligible the next time the user
      // clicks Queue.
      const eligible = beats.filter((b) => {
        if (!b.videoPrompt) return false;
        if (!b.imageUrl) return false;
        if (b.videoUrl) return false;
        if (mode === "failed") return b.videoStatus === "failed";
        return true;
      });
      if (eligible.length === 0) return;
      const res = await fetch("/api/generate/videos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          beats: eligible.map((b) => ({ beatNumber: b.beatNumber, videoPrompt: b.videoPrompt, imageUrl: b.imageUrl })),
          modelId: selectedVideoModel,
          aspectRatio: selectedVideoAspectRatio,
          ...(selectedDuration !== null ? { duration: selectedDuration } : {}),
        }),
      });
      const data = await res.json().catch(() => ({})) as { submitted?: number; failures?: { beatNumber: number; error: string }[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `Request failed (HTTP ${res.status})`);
      setVideosSubmitted(true);
      const verb = mode === "failed" ? "re-submitted" : "submitted";
      if ((data.submitted ?? 0) > 0) toast.success(`${data.submitted ?? 0} video clips ${verb}`);
      if (data.failures?.length) {
        setVideoRunError(friendlyError(data.failures[0].error));
      }
    } catch (err) {
      setVideoRunError(friendlyError(err instanceof Error ? err.message : null));
    } finally {
      setQueuingVideos(false);
    }
  }

  async function exportDocx() {
    try {
      const res = await fetch("/api/export/docx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId }),
      });
      if (!res.ok) throw new Error("Export failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${project?.channel_name ?? "export"}_content.docx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    }
  }

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: "var(--bg-page-2)" }}>
      <WizardNav
        projectId={projectId}
        currentState={14}
        highestState={project?.current_state}
        channelName={project?.channel_name}
        topRightExtra={
          <button
            onClick={exportDocx}
            className="flex items-center px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80"
            style={{ background: "transparent", color: "var(--c-55)", border: "1px solid var(--bd-8)" }}
          >
            Export Doc
          </button>
        }
      />

      <main className="flex-1 flex flex-col overflow-hidden pt-[105px] md:pt-0">
        {/* Header */}
        <div className="shrink-0 sm:px-8 md:pr-44 py-4 sm:py-5"
          style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header-2)", backdropFilter: "blur(12px)" }}>
          <div>
            <h1 className="font-bold text-base sm:text-lg">Generate Assets</h1>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              Select a model for each service, then generate your final content
            </p>
            <div className="mt-3">
              <StepCostCard projectId={projectId} column="generate" />
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto pb-[70px]">
        <div className="py-4 sm:p-8 grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
          {/* Image Gen Panel */}
          <div className="rounded-2xl flex flex-col overflow-hidden h-full"
            style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
            <div className="p-5 min-h-[500px]" style={{ borderBottom: "1px solid var(--bd-6)" }}>
              <SectionHeader icon={<ImageIcon size={18} />} title="AI Images" subtitle={`${totalBeats} images from script beats`} />
              <ModelPicker
                type="image"
                models={imageModels}
                selectedModelId={selectedImageModel}
                onSelectModel={setSelectedImageModel}
                selectedAspectRatio={selectedAspectRatio}
                onSelectAspectRatio={setSelectedAspectRatio}
                selectedResolution={selectedResolution}
                onSelectResolution={setSelectedResolution}
              />
            </div>

            {beatsStale && (
              <div className="px-5 pt-4">
                <div className="rounded-xl px-3 py-2.5 flex items-start gap-2 text-xs"
                  style={{ background: "oklch(0.72 0.16 70 / 0.12)", border: "1px solid oklch(0.72 0.16 70 / 0.35)", color: "oklch(0.85 0.12 70)" }}>
                  <span aria-hidden>⚠</span>
                  <span>
                    Script was edited after these beats were generated. Any images below were prompted from the old script — regenerate the beats in <strong>Prompt Studio</strong> before re-running images.
                  </span>
                </div>
              </div>
            )}

            {/* Image gallery */}
            {(beats.some((b) => b.imageUrl || b.imageStatus) || regenBeats.size > 0) && (
              <div className="px-5 pt-4">
                <ProgressBar value={clearingImages ? 0 : generatedImages} total={totalBeats} />
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-1.5 mt-3 max-h-[440px] sm:max-h-72 overflow-y-auto scroll-visible pr-1">
                  {beats.map((b) => {
                    const isRegening = regenBeats.has(b.beatNumber);
                    return (
                      <div
                        key={b.beatNumber}
                        className="relative aspect-video rounded-lg overflow-hidden group"
                        style={{ background: "var(--bg-progress)" }}
                        onClick={() => {
                          if (!b.imageUrl || clearingImages) return;
                          // Touch-only: desktop already has the hover preview.
                          if (!window.matchMedia("(hover: none) and (pointer: coarse)").matches) return;
                          setPreviewBeat({ beat: b, type: "image" });
                        }}
                        onMouseEnter={(e) => {
                          if (!b.imageUrl || clearingImages) return;
                          // Same hover gate as the video tile — keeps mobile
                          // taps from sticky-opening the floating preview.
                          if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
                          setHoveredImageBeat(b);
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          const PREVIEW_WIDTH = 280;
                          const GAP = 8;
                          // Prefer right side of the thumbnail; flip
                          // left if the preview would overflow the
                          // viewport on the right (rightmost grid
                          // column). Clamp top to keep the preview
                          // on screen when the thumbnail is near
                          // the bottom edge.
                          let left = rect.right + GAP;
                          if (left + PREVIEW_WIDTH > window.innerWidth - 8) {
                            left = rect.left - PREVIEW_WIDTH - GAP;
                          }
                          const top = Math.max(8, Math.min(window.innerHeight - 280, rect.top));
                          setHoveredImageAnchor({ top, left });
                        }}
                        onMouseLeave={() => { setHoveredImageBeat(null); setHoveredImageAnchor(null); }}
                      >
                        {b.imageUrl && !clearingImages ? (
                          <img src={b.imageUrl} alt={`Beat ${b.beatNumber}`} className="w-full h-full object-cover" />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center">
                            <span className="text-[10px]" style={{ color: "var(--c-35)" }}>{b.beatNumber}</span>
                          </div>
                        )}

                        {/* Edit-prompt affordance — top-right pill that
                            opens the prompt-edit modal. Only shown
                            for tiles with an existing image; the
                            empty-tile state already has its own
                            "Generate" CTA in the center. */}
                        {b.imageUrl && !clearingImages && !isRegening && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditedPrompt(b.imagePrompt ?? "");
                              setEditPromptBeat(b);
                            }}
                            disabled={!selectedImageModel || generatingImages || generatingTts}
                            title="Edit prompt & regenerate"
                            aria-label={`Edit prompt for beat ${b.beatNumber}`}
                            className="absolute top-1.5 right-1.5 z-10 w-7 h-7 rounded-full flex items-center justify-center transition-all opacity-100 sm:opacity-0 sm:group-hover:opacity-100 disabled:opacity-30 disabled:cursor-not-allowed hover:scale-110"
                            style={{
                              background: "oklch(0 0 0 / 0.6)",
                              color: "white",
                              border: "1px solid oklch(1 0 0 / 0.15)",
                            }}
                          >
                            <Pencil size={12} strokeWidth={2.4} />
                          </button>
                        )}

                        {/* Regen overlay — spinner on top of a dimmed
                            existing image so the user can see the
                            old frame while waiting for the new one. */}
                        {isRegening ? (
                          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1"
                            style={{ background: "oklch(0 0 0 / 0.55)" }}>
                            <Spinner size={20} className="text-white" />
                            <span className="text-[10px] font-medium" style={{ color: "oklch(0.95 0 0)" }}>
                              Regenerating…
                            </span>
                          </div>
                        ) : (
                          <div className={`absolute inset-0 flex items-center justify-center transition-opacity ${b.imageUrl ? "opacity-0 group-hover:opacity-100" : "opacity-100"}`}
                            style={{ background: b.imageUrl ? "oklch(0 0 0 / 0.55)" : "transparent" }}>
                            {/* Status-specific affordance — matches the
                                video side's icon system:
                                  - no image, status=failed → RefreshCw (Retry)
                                  - no image (any other status) → Wand2 (Generate)
                                  - has image → RotateCcw (Regenerate)
                                Previously we only used Wand2 when BOTH
                                imageUrl AND imageStatus were nullish,
                                so a tile carrying e.g. imageStatus
                                "pending" fell through to RotateCcw
                                even though no image had ever been
                                produced — which read as a regenerate
                                affordance for content that didn't
                                exist yet. */}
                            {(() => {
                              // Icon ref typed as the loose
                              // component shape ({ size, strokeWidth,
                              // className }) so both lucide icons
                              // (ForwardRef components) and our
                              // custom ImageSparkle (plain function
                              // component) can be assigned.
                              let Icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }> = RotateCcw;
                              let label = "Regenerate";
                              if (!b.imageUrl) {
                                if (b.imageStatus === "failed") {
                                  Icon = RefreshCw;
                                  label = "Retry";
                                } else {
                                  Icon = ImageSparkle;
                                  label = "Generate";
                                }
                              }
                              return (
                                <button
                                  onClick={(e) => { e.stopPropagation(); regenerateImage(b); }}
                                  disabled={!selectedImageModel || generatingImages || generatingTts}
                                  title={generatingTts ? "Voiceover is generating — wait for it to finish" : `${label} beat ${b.beatNumber}`}
                                  aria-label={`${label} beat ${b.beatNumber}`}
                                  className="w-9 h-9 sm:w-10 sm:h-10 rounded-full flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200 hover:scale-110 cursor-pointer"
                                  style={{
                                    background: "oklch(0.72 0.25 285)",
                                    color: "white",
                                    boxShadow: "0 4px 16px oklch(0.72 0.25 285 / 0.55), 0 0 0 2px oklch(1 0 0 / 0.15)",
                                  }}
                                >
                                  <Icon size={20} strokeWidth={2.4} />
                                </button>
                              );
                            })()}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="p-5 mt-auto space-y-2">
              {(() => {
                // Three button states keyed off pendingCount:
                //   • pendingCount === totalBeats → first-time run: "Generate N Images"
                //   • 0 < pendingCount < totalBeats → partial fail: "Generate Remaining N"
                //   • pendingCount === 0 → all done: "Regenerate All" (this one wipes)
                const pendingCount = totalBeats - generatedImages;
                const isPartial = generatedImages > 0 && pendingCount > 0;
                const isAllDone = generatedImages > 0 && pendingCount === 0;
                const workingImageName = imageModels?.find((m) => m.id === selectedImageModel)?.name ?? "the selected model";
                const kieCredits = apiStatus?.kie?.credits;
                const showCreditBanner = outOfCredits || (typeof kieCredits === "number" && kieCredits <= 0);
                return (
                  <>
                    {showCreditBanner && (
                      <div className="px-3 py-2 rounded-lg text-xs leading-snug flex items-start gap-2"
                        style={{ background: "oklch(0.6 0.22 25 / 0.1)", border: "1px solid oklch(0.6 0.22 25 / 0.3)", color: "oklch(0.78 0.12 25)" }}>
                        <span aria-hidden style={{ marginTop: "1px" }}>⚠</span>
                        <span>
                          <span style={{ fontWeight: 600 }}>KIE credits exhausted.</span>{" "}
                          Top up your account at{" "}
                          <a href="https://kie.ai/billing" target="_blank" rel="noopener noreferrer"
                            style={{ textDecoration: "underline", fontWeight: 600 }}>
                            kie.ai/billing
                          </a>{" "}
                          to keep generating.
                        </span>
                      </div>
                    )}
                    {isPartial && !generatingImages && !showCreditBanner && !userStoppedImages && (
                      <div ref={imageErrorBannerRef} className="px-3 py-2 rounded-lg text-xs leading-snug space-y-1"
                        style={{ background: "oklch(0.6 0.22 25 / 0.08)", border: "1px solid oklch(0.6 0.22 25 / 0.25)", color: "oklch(0.78 0.12 25)" }}>
                        <p>
                          {pendingCount} image{pendingCount === 1 ? "" : "s"} didn't generate on <span style={{ fontWeight: 600 }}>{workingImageName}</span>. Try switching to a different model above, then run again.
                        </p>
                        {imageRunError && (
                          <p style={{ color: "oklch(0.85 0.08 25)" }}>{imageRunError}</p>
                        )}
                      </div>
                    )}
                    {generatingImages && (
                      <button
                        onClick={handleStopImages}
                        disabled={stoppingImages}
                        title="Halt the submission loop — already-submitted beats keep running and land via webhook / cron"
                        className="w-full py-2 rounded-xl text-xs font-medium transition-all hover:opacity-90 disabled:opacity-60"
                        style={{ background: "oklch(0.6 0.22 25 / 0.1)", border: "1px solid oklch(0.6 0.22 25 / 0.4)", color: "oklch(0.7 0.22 25)" }}
                      >
                        {stoppingImages ? "Stopping…" : "Stop generation"}
                      </button>
                    )}
                    <button
                      onClick={() => generateImages({ mode: isAllDone ? "all" : "remaining" })}
                      disabled={generatingImages || generatingTts || !selectedImageModel || !beats.length || showCreditBanner}
                      title={generatingTts ? "Voiceover is generating — wait for it to finish before starting image generation" : showCreditBanner ? "KIE credits exhausted — top up to continue" : undefined}
                      className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                      style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                    >
                      {generatingImages ? (
                        <span className="flex items-center justify-center gap-2">
                          <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                          {`Generating… ${clearingImages ? 0 : generatedImages}/${totalBeats}`}
                        </span>
                      ) : isPartial
                        ? `Generate Remaining ${pendingCount}`
                        : isAllDone
                        ? `Regenerate All (${totalBeats})`
                        : `Generate ${totalBeats} Images`}
                    </button>
                    {/* Secondary "Regenerate All" affordance when some images
                        succeeded but others failed — gives users a way to
                        explicitly start over if they don't trust the
                        partial state. Wipes existing images. */}
                    {isPartial && !generatingImages && (
                      <button
                        onClick={() => setRegenerateAllConfirmOpen(true)}
                        disabled={generatingTts || !selectedImageModel || showCreditBanner}
                        className="w-full py-2 rounded-xl text-xs font-semibold disabled:opacity-40 transition-all hover:opacity-90 flex items-center justify-center gap-1.5"
                        style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                      >
                        <RotateCcw size={14} strokeWidth={2.4} />
                        {`Regenerate All (${totalBeats})`}
                      </button>
                    )}
                  </>
                );
              })()}
            </div>
          </div>

          {/* Video Gen Panel */}
          <div className="rounded-2xl flex flex-col overflow-hidden h-full"
            style={{ background: "var(--bg-panel)", border: "1px solid var(--bd-7)" }}>
            <div className="p-5 min-h-[500px]" style={{ borderBottom: "1px solid var(--bd-6)" }}>
              <SectionHeader icon={<Video size={18} />} title="AI Video Clips" subtitle={`${videoBeats} clips · 3–5s each`} />
              <ModelPicker
                type="video"
                models={videoModels}
                selectedModelId={selectedVideoModel}
                onSelectModel={setSelectedVideoModel}
                selectedAspectRatio={selectedVideoAspectRatio}
                onSelectAspectRatio={setSelectedVideoAspectRatio}
                selectedDuration={selectedDuration ?? ""}
                onSelectDuration={setSelectedDuration}
              />
            </div>

            {beatsStale && (
              <div className="px-5 pt-4">
                <div className="rounded-xl px-3 py-2.5 flex items-start gap-2 text-xs"
                  style={{ background: "oklch(0.72 0.16 70 / 0.12)", border: "1px solid oklch(0.72 0.16 70 / 0.35)", color: "oklch(0.85 0.12 70)" }}>
                  <span aria-hidden>⚠</span>
                  <span>
                    Script was edited after these beats were generated. Any clips below were prompted from the old script — regenerate the beats in <strong>Prompt Studio</strong> before re-running videos.
                  </span>
                </div>
              </div>
            )}

            {/* Video clip grid — mirrors image panel structure: progress + grid in one block.
                Renders placeholder cells (status "—") for every beat with a videoPrompt
                so the user sees the workflow scaffold before queuing any clips. */}
            {beats.some((b) => b.videoPrompt) && (
              <div className="px-5 pt-4">
                <ProgressBar value={generatedVideos} total={videoBeats} />
                <div className="grid grid-cols-1 sm:grid-cols-4 gap-1.5 mt-3 max-h-[440px] sm:max-h-72 overflow-y-auto scroll-visible pr-1">
                    {beats.filter((b) => b.videoPrompt).map((b) => (
                      <div
                        key={b.beatNumber}
                        className="aspect-video rounded-lg overflow-hidden flex items-center justify-center relative group"
                        style={{ background: "var(--bg-progress)" }}
                        onClick={() => {
                          if (!b.videoUrl) return;
                          if (!window.matchMedia("(hover: none) and (pointer: coarse)").matches) return;
                          setPreviewBeat({ beat: b, type: "video" });
                        }}
                        onMouseEnter={(e) => {
                          if (!b.videoUrl) return;
                          // Touch devices fire mouseenter on tap but never
                          // mouseleave — the preview would open and stick
                          // until the user tapped something else. Gate the
                          // hover preview to genuine hover-capable pointers.
                          if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
                          if (videoHideTimer.current) clearTimeout(videoHideTimer.current);
                          setHoveredVideoBeat(b);
                          // Always anchor the preview to the LEFT of
                          // the thumbnail so the position is
                          // consistent across the grid — no flip,
                          // no surprise. Top is clamped so the
                          // preview stays on screen near the grid's
                          // bottom edge. If the leftmost column would
                          // push the preview off the left side of
                          // the viewport, we clamp to a small inset
                          // so the user still sees it.
                          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                          const PREVIEW_WIDTH = 320;
                          const PREVIEW_HEIGHT = 280;
                          const GAP = 8;
                          const left = Math.max(8, rect.left - PREVIEW_WIDTH - GAP);
                          const top = Math.max(8, Math.min(window.innerHeight - PREVIEW_HEIGHT - 8, rect.top));
                          setHoveredVideoAnchor({ top, left });
                        }}
                        onMouseLeave={() => {
                          videoHideTimer.current = setTimeout(() => {
                            setHoveredVideoBeat(null);
                            setHoveredVideoAnchor(null);
                          }, 200);
                        }}
                      >
                        {/* Background layer: video if we have one,
                            status badge otherwise. The spinner +
                            regen overlays below sit on top of either. */}
                        {b.videoUrl ? (
                          <video
                            src={b.videoUrl}
                            title={b.videoUrl}
                            className="w-full h-full object-cover"
                            muted
                            autoPlay
                            loop
                            playsInline
                            disablePictureInPicture
                            controlsList="nodownload nofullscreen noplaybackrate noremoteplayback"
                          />
                        ) : !b.videoStatus ? (
                          // Pre-queue placeholder — the beat has a prompt
                          // but hasn't been submitted yet. A video icon
                          // signals "this slot will hold a clip" more
                          // clearly than a bare "—" badge.
                          <Video size={20} style={{ color: "var(--c-30)" }} aria-label="No clip yet" />
                        ) : (
                          <span className="text-[10px] px-1.5 py-0.5 rounded"
                            title={b.videoStatus === "failed" && b.videoError ? b.videoError : undefined}
                            style={{
                              background: b.videoStatus === "rendering" ? "oklch(0.72 0.25 285 / 0.1)" : b.videoStatus === "done" ? "oklch(0.55 0.15 145 / 0.1)" : b.videoStatus === "failed" ? "oklch(0.6 0.22 25 / 0.1)" : "var(--bg-track)",
                              color: b.videoStatus === "rendering" ? "oklch(0.72 0.25 285)" : b.videoStatus === "done" ? "oklch(0.7 0.15 145)" : b.videoStatus === "failed" ? "oklch(0.7 0.2 25)" : "var(--c-35)",
                              cursor: b.videoStatus === "failed" && b.videoError ? "help" : undefined,
                            }}>
                            {/* Status badge maps 1:1 to the DB state so
                                only the beat the worker is currently
                                talking to KIE about reads as
                                "submitting" — other beats in the same
                                batch stay on "queued" until the worker
                                gets to them. The transition the user
                                sees per beat is:
                                queued → submitting → rendering → done. */}
                            {b.videoStatus}
                          </span>
                        )}

                        {/* In-flight overlay — mirrors the image
                            side's regen spinner. Replaces the static
                            status badge with a spinner + matching
                            "submitting…" / "rendering…" label so the
                            user gets a clear "work is happening here
                            right now" signal. Sits over the video
                            too, dimming the old frame while a regen
                            is mid-flight. */}
                        {(b.videoStatus === "submitting" || b.videoStatus === "rendering") && (
                          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1"
                            style={{ background: "oklch(0 0 0 / 0.55)" }}>
                            <Spinner size={20} className="text-white" />
                            <span className="text-[10px] font-medium" style={{ color: "oklch(0.95 0 0)" }}>
                              {b.videoStatus}…
                            </span>
                          </div>
                        )}

                        {/* Regen overlay — uniform across every tile
                            state (done / failed / paused / pending /
                            empty). Hover-fades a dim backdrop with
                            a big centered purple-glow circle that
                            opens the per-beat regenerate confirm
                            modal. Disabled while the beat itself is
                            actively in-flight (queued or rendering)
                            so we don't double-queue the same task,
                            and during global active-video ops. */}
                        {(() => {
                          const inFlight = b.videoStatus === "queued" || b.videoStatus === "submitting" || b.videoStatus === "rendering";
                          const disabled = inFlight || regeneratingVideo || queuingVideos || hasActiveVideos;
                          // Status-specific affordance so the icon
                          // matches the intent at a glance:
                          //   - no clip yet (no videoUrl + no status)
                          //              → Wand2 (Generate; matches the
                          //                image-side affordance for
                          //                first-time creation).
                          //   - paused  → ChevronsRight (fast-forward;
                          //               "continue this work").
                          //               Avoids the Play triangle
                          //               which read as a video play
                          //               button over the autoplaying
                          //               clip.
                          //   - failed  → RefreshCw (retry; the
                          //               standard retry affordance).
                          //   - other   → RotateCcw (regenerate;
                          //               redo from scratch).
                          let Icon: typeof RotateCcw = RotateCcw;
                          let label = "Regenerate";
                          if (!b.videoUrl && !b.videoStatus) {
                            Icon = Wand2;
                            label = "Generate";
                          } else if (b.videoStatus === "paused") {
                            Icon = ChevronsRight;
                            label = "Resume";
                          } else if (b.videoStatus === "failed") {
                            Icon = RefreshCw;
                            label = "Retry";
                          }
                          return (
                            <div className="absolute inset-0 flex items-center justify-center transition-opacity opacity-0 group-hover:opacity-100"
                              style={{ background: "oklch(0 0 0 / 0.55)" }}>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  void regenerateVideoBeat(b.beatNumber);
                                }}
                                disabled={disabled}
                                title={inFlight ? `Beat ${b.beatNumber} is ${b.videoStatus} — wait for it to finish` : `${label} beat ${b.beatNumber}`}
                                aria-label={`${label} beat ${b.beatNumber}`}
                                className="w-9 h-9 sm:w-10 sm:h-10 rounded-full flex items-center justify-center disabled:opacity-40 disabled:cursor-not-allowed transition-all duration-200 hover:scale-110 cursor-pointer"
                                style={{
                                  background: "oklch(0.72 0.25 285)",
                                  color: "white",
                                  boxShadow: "0 4px 16px oklch(0.72 0.25 285 / 0.55), 0 0 0 2px oklch(1 0 0 / 0.15)",
                                }}
                              >
                                <Icon size={20} strokeWidth={2.4} />
                              </button>
                            </div>
                          );
                        })()}
                      </div>
                    ))}
                </div>
              </div>
            )}

            <div className="p-5 mt-auto space-y-2">
              {((failedVideos > 0 && !hasActiveVideos) || videoRunError) && (() => {
                const workingId = project?.video_model_id as string | undefined;
                const workingName = videoModels?.find((m) => m.id === workingId)?.name ?? "the selected model";
                // Pick the message body: the most recent action-level
                // error (videoRunError) wins over the per-beat error
                // when both are present — it's almost always the more
                // immediate failure to surface. Fall back to the
                // latest failed beat's videoError (highest beatNumber
                // = most recently submitted) when no action error is
                // set.
                const failedWithError = beats
                  .filter((b) => b.videoStatus === "failed" && b.videoError)
                  .sort((a, b) => b.beatNumber - a.beatNumber);
                const beatError = failedWithError.length > 0
                  ? friendlyError(failedWithError[0].videoError!)
                  : null;
                const currentError = videoRunError ?? beatError;
                return (
                  <div ref={videoErrorBannerRef} className="px-3 py-2 rounded-lg text-xs leading-snug space-y-1"
                    style={{ background: "oklch(0.6 0.22 25 / 0.08)", border: "1px solid oklch(0.6 0.22 25 / 0.25)", color: "oklch(0.78 0.12 25)" }}>
                    {failedVideos > 0 && (
                      <p>
                        {failedVideos} clip{failedVideos === 1 ? "" : "s"} failed on <span style={{ fontWeight: 600 }}>{workingName}</span>. Try switching to a different model above, then retry.
                      </p>
                    )}
                    {currentError && (
                      <p style={{ color: "oklch(0.85 0.08 25)" }}>{currentError}</p>
                    )}
                  </div>
                );
              })()}
              {/* Primary action morphs by state:
                  - queuing-in-flight: spinner
                  - paused beats exist: Resume (green)
                  - queued beats exist: Pause (orange)
                  - pending work remains: Queue (purple)
                  - nothing to do: disabled Queue
                  Retry Failed stays as a secondary button when applicable. */}
              {queuingVideos ? (
                <button
                  disabled
                  className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                  style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                >
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    Queuing clips…
                  </span>
                </button>
              ) : pausedVideos > 0 ? (
                <button
                  onClick={resumeVideos}
                  disabled={!selectedVideoModel || resumingVideos || videosBlockedByImages}
                  title={videoBlockReason}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                  style={{ background: "oklch(0.7 0.15 145)", color: "var(--bg-page-2)" }}
                >
                  {resumingVideos ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      Resuming…
                    </span>
                  ) : `Resume ${pausedVideos} Clip${pausedVideos === 1 ? "" : "s"}`}
                </button>
              ) : queuedVideos > 0 ? (
                <button
                  onClick={pauseVideos}
                  disabled={pausingVideos}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                  style={{ background: "transparent", color: "oklch(0.7 0.2 25)", border: "1px solid oklch(0.7 0.2 25)" }}
                >
                  {pausingVideos ? (
                    <span className="flex items-center justify-center gap-2">
                      <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      Pausing…
                    </span>
                  ) : `Pause ${queuedVideos} Pending`}
                </button>
              ) : failedVideos > 0 && pendingVideos === failedVideos ? (
                <button
                  onClick={() => queueVideos("failed")}
                  disabled={!selectedVideoModel || videosBlockedByImages}
                  title={videoBlockReason}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                  style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                >
                  Re-queue {failedVideos} Clip{failedVideos === 1 ? "" : "s"}
                </button>
              ) : (
                <button
                  onClick={() => queueVideos("all")}
                  disabled={!selectedVideoModel || !pendingVideosWithImages || hasActiveVideos || videosBlockedByImages}
                  title={videoBlockReason}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                  style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
                >
                  {videosBlockedByImages
                    ? `Waiting on first image (${generatedImages}/${totalBeats})`
                    : `Queue ${pendingVideosWithImages} Video Clip${pendingVideosWithImages === 1 ? "" : "s"}`}
                </button>
              )}
              {/* Show the secondary "Retry Failed" only when there are also some
                  never-attempted beats — otherwise the primary "Re-queue" already
                  covers the failed-only case. */}
              {failedVideos > 0 && pendingVideos > failedVideos && !hasActiveVideos && !queuingVideos && (
                <button
                  onClick={() => queueVideos("failed")}
                  disabled={!selectedVideoModel || videosBlockedByImages}
                  title={videoBlockReason}
                  className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                  style={{ background: "transparent", color: "oklch(0.72 0.25 285)", border: "1px solid oklch(0.72 0.25 285)" }}
                >
                  Retry {failedVideos} Failed
                </button>
              )}
            </div>
          </div>
        </div>
        </div>
      </main>

      {/* Fixed bottom bar */}
      {(() => {
        // Only hard gate now: at least one beat has an image. Voiceover
        // (legacy tts_url) and videos are soft — the user may have
        // per-beat voiceovers (a separate step) or be intentionally
        // skipping clips. The assemble step gracefully handles missing
        // pieces, so the button stays usable as soon as there's
        // something to assemble.
        const hasAnyImage = generatedImages > 0;
        const canContinue = hasAnyImage;
        const pendingImageCount = totalBeats > 0 ? totalBeats - generatedImages : 0;
        const someImagesPending = canContinue && pendingImageCount > 0;
        const pendingVideoCount = videoBeats > 0 ? videoBeats - generatedVideos : 0;
        const noVideosYet = canContinue && videoBeats > 0 && generatedVideos === 0;
        const someVideosPending = canContinue && videoBeats > 0 && pendingVideoCount > 0 && !noVideosYet;
        // "Continue anyway" wins as soon as anything is still pending
        // (images OR videos), since we're advancing on a partial set.
        const continueLabel = (someImagesPending || someVideosPending || noVideosYet)
          ? "Continue anyway"
          : "Continue →";

        return (
          <div className="fixed bottom-0 left-0 md:left-64 right-0 z-20 py-3"
            style={{ background: "var(--bg-header-2)", borderTop: "1px solid var(--bd-6)", backdropFilter: "blur(12px)" }}>
            <div className="sm:px-8 space-y-2">
              {!canContinue && !navigating && (
                <p className="text-xs text-center" style={{ color: "var(--c-40)" }}>
                  Generate at least one image to continue.
                </p>
              )}
              {!navigating && someImagesPending && (
                <p className="text-xs text-center" style={{ color: "var(--c-40)" }}>
                  {pendingImageCount} beat{pendingImageCount === 1 ? "" : "s"} still without image — {pendingImageCount === 1 ? "it will" : "they will"} be skipped at assembly.
                </p>
              )}
              {!navigating && noVideosYet && (
                <p className="text-xs text-center" style={{ color: "var(--c-40)" }}>
                  No video clips yet — every beat will use its image at assembly.
                </p>
              )}
              {!navigating && someVideosPending && (
                <p className="text-xs text-center" style={{ color: "var(--c-40)" }}>
                  {pendingVideoCount} clip{pendingVideoCount === 1 ? "" : "s"} without video — the matching image{pendingVideoCount === 1 ? "" : "s"} will be used in those spots.
                </p>
              )}
              <button
                onClick={() => { setNavigating(true); router.push(`/projects/${projectId}/assemble`); }}
                disabled={navigating || !canContinue}
                className="w-full py-2.5 rounded-xl text-sm font-semibold disabled:opacity-40 transition-all"
                style={{ background: "oklch(0.72 0.25 285)", color: "var(--bg-page-2)" }}
              >
                {navigating ? (
                  <span className="flex items-center justify-center gap-2">
                    <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    Loading…
                  </span>
                ) : continueLabel}
              </button>
            </div>
          </div>
        );
      })()}

      {/* Video hover preview — anchored next to the hovered tile via
          hoveredVideoAnchor, matching the image preview's positioning
          rather than fixing in the bottom-right corner. */}
      {hoveredVideoBeat?.videoUrl && hoveredVideoAnchor && (
        <div
          className="fixed z-50 rounded-xl overflow-hidden shadow-2xl"
          style={{
            top: hoveredVideoAnchor.top,
            left: hoveredVideoAnchor.left,
            width: "320px",
            border: "1px solid var(--bd-10)",
            background: "var(--bg-page-2)",
          }}
          onMouseEnter={() => {
            if (videoHideTimer.current) clearTimeout(videoHideTimer.current);
          }}
          onMouseLeave={() => {
            videoHideTimer.current = setTimeout(() => {
              setHoveredVideoBeat(null);
              setHoveredVideoAnchor(null);
            }, 200);
          }}
        >
          <video
            key={hoveredVideoBeat.videoUrl}
            src={hoveredVideoBeat.videoUrl}
            className="w-full"
            style={{ aspectRatio: "16/9", display: "block" }}
            autoPlay
            loop
            playsInline
            controls
          />
          <div className="px-3 py-2">
            <p className="text-xs font-semibold mb-0.5" style={{ color: "var(--c-55)" }}>
              Beat {hoveredVideoBeat.beatNumber}
            </p>
            <p className="text-xs leading-relaxed line-clamp-3" style={{ color: "var(--c-45)" }}>
              {hoveredVideoBeat.videoPrompt}
            </p>
          </div>
        </div>
      )}

      {/* Image hover preview — anchored next to the hovered
          thumbnail via hoveredImageAnchor (computed onMouseEnter).
          Flips to the left side automatically when the thumbnail
          is in the rightmost grid column. */}
      {hoveredImageBeat?.imageUrl && hoveredImageAnchor && (
        <div
          className="fixed z-50 pointer-events-none rounded-xl overflow-hidden shadow-2xl"
          style={{
            top: hoveredImageAnchor.top,
            left: hoveredImageAnchor.left,
            width: "280px",
            border: "1px solid var(--bd-10)",
            background: "var(--bg-panel)",
          }}
        >
          <img
            src={hoveredImageBeat.imageUrl}
            alt={`Beat ${hoveredImageBeat.beatNumber}`}
            className="w-full object-cover"
            style={{ aspectRatio: "16/9" }}
          />
          <div className="px-3 py-2">
            <p className="text-xs font-semibold mb-0.5" style={{ color: "var(--c-55)" }}>
              Beat {hoveredImageBeat.beatNumber}
            </p>
            <p className="text-xs leading-relaxed line-clamp-3" style={{ color: "var(--c-45)" }}>
              {hoveredImageBeat.imagePrompt}
            </p>
          </div>
        </div>
      )}

      <Dialog open={regenerateAllConfirmOpen} onOpenChange={(open) => { if (!generatingImages && !regenerateAllSubmitting) setRegenerateAllConfirmOpen(open); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Regenerate all images?</DialogTitle>
            <DialogDescription>
              This will <strong>wipe every existing image</strong> on this project and generate {totalBeats} fresh image{totalBeats === 1 ? "" : "s"} from your prompts. KIE credits will be charged for the new generations. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setRegenerateAllConfirmOpen(false)}
              disabled={generatingImages || regenerateAllSubmitting}
              className="px-4 py-2 rounded-lg text-sm font-medium border border-zinc-200 bg-white text-zinc-700 hover:bg-zinc-50 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              onClick={async () => {
                setRegenerateAllSubmitting(true);
                // Kick off the long-running image work; it manages its
                // own page-level progress UI from here. Brief await
                // gives the user visual confirmation in the modal
                // before we dismiss.
                void generateImages({ mode: "all" });
                await new Promise((r) => setTimeout(r, 400));
                setRegenerateAllSubmitting(false);
                setRegenerateAllConfirmOpen(false);
              }}
              disabled={generatingImages || regenerateAllSubmitting}
              className="px-4 py-2 rounded-lg text-sm font-semibold text-white transition-all disabled:opacity-60"
              style={{ background: "oklch(0.72 0.25 285)" }}
            >
              {regenerateAllSubmitting ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Starting…
                </span>
              ) : "Regenerate all"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!previewBeat} onOpenChange={(open) => { if (!open) setPreviewBeat(null); }}>
        <DialogContent className="sm:max-w-lg p-0 overflow-hidden" showCloseButton={false}>
          {previewBeat?.type === "image" && previewBeat.beat.imageUrl && (
            <img
              src={previewBeat.beat.imageUrl}
              alt={`Beat ${previewBeat.beat.beatNumber}`}
              className="w-full"
              style={{ aspectRatio: "16/9", objectFit: "cover", display: "block" }}
            />
          )}
          {previewBeat?.type === "video" && previewBeat.beat.videoUrl && (
            <video
              key={previewBeat.beat.videoUrl}
              src={previewBeat.beat.videoUrl}
              className="w-full"
              style={{ aspectRatio: "16/9", objectFit: "cover", display: "block" }}
              autoPlay
              loop
              playsInline
              controls
            />
          )}
          <div className="px-4 py-3">
            <p className="text-xs font-semibold mb-1" style={{ color: "var(--c-55)" }}>
              Beat {previewBeat?.beat.beatNumber}
            </p>
            <p className="text-xs leading-relaxed" style={{ color: "var(--c-45)" }}>
              {previewBeat?.type === "image" ? previewBeat?.beat.imagePrompt : previewBeat?.beat.videoPrompt}
            </p>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editPromptBeat} onOpenChange={(open) => { if (!open && !editPromptSubmitting) setEditPromptBeat(null); }}>
        <DialogContent
          className="sm:max-w-lg"
          style={{ background: "white", color: "oklch(0.15 0 0)" }}
        >
          <DialogHeader>
            <DialogTitle style={{ color: "oklch(0.15 0 0)" }}>
              Edit prompt for beat {editPromptBeat?.beatNumber}
            </DialogTitle>
            <div className="flex flex-col-reverse sm:flex-row sm:items-center gap-3">
              <DialogDescription className="flex-1 m-0" style={{ color: "oklch(0.4 0 0)" }}>
                Tweak the image prompt below. Saving will regenerate the image with the new prompt and update Prompt Studio to match.
              </DialogDescription>
              {editPromptBeat?.imageUrl && (
                <img
                  src={editPromptBeat.imageUrl}
                  alt={`Beat ${editPromptBeat.beatNumber}`}
                  className="w-full sm:w-32 rounded-md object-cover shrink-0"
                  style={{ aspectRatio: "16/9", border: "1px solid oklch(0.9 0 0)" }}
                />
              )}
            </div>
          </DialogHeader>
          <textarea
            value={editedPrompt}
            onChange={(e) => setEditedPrompt(e.target.value)}
            rows={6}
            className="w-full px-3 py-2 rounded-lg text-sm outline-none resize-y sm:min-h-[180px]"
            style={{ background: "white", border: "1px solid oklch(0.85 0 0)", color: "oklch(0.15 0 0)" }}
            placeholder="Image prompt…"
          />
          <DialogFooter style={{ background: "white", borderTop: "1px solid oklch(0.9 0 0)" }}>
            <button
              onClick={() => setEditPromptBeat(null)}
              disabled={editPromptSubmitting}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-40"
              style={{ background: "white", border: "1px solid oklch(0.85 0 0)", color: "oklch(0.3 0 0)" }}
            >
              Cancel
            </button>
            {(() => {
              const trimmed = editedPrompt.trim();
              const unchanged = trimmed === (editPromptBeat?.imagePrompt ?? "").trim();
              const canSave = !!trimmed && !!selectedImageModel && !unchanged && !editPromptSubmitting;
              return (
                <button
                  type="button"
                  onClick={async () => {
                    if (!canSave || !editPromptBeat) return;
                    const beat = editPromptBeat;
                    setEditPromptSubmitting(true);
                    // Fire-and-forget the regen; the beat card flips
                    // to its own "regenerating" state in the page UI.
                    // Brief await before closing so the click registers
                    // visibly in the modal.
                    void regenerateImage(beat, trimmed);
                    await new Promise((r) => setTimeout(r, 400));
                    setEditPromptSubmitting(false);
                    setEditPromptBeat(null);
                  }}
                  disabled={!canSave}
                  aria-disabled={!canSave}
                  className="px-4 py-2 rounded-lg text-sm font-semibold transition-all"
                  style={{
                    background: canSave || editPromptSubmitting ? "oklch(0.72 0.25 285)" : "oklch(0.90 0 0)",
                    color: canSave || editPromptSubmitting ? "white" : "oklch(0.65 0 0)",
                    cursor: canSave ? "pointer" : "not-allowed",
                    pointerEvents: canSave ? "auto" : "none",
                    opacity: canSave || editPromptSubmitting ? 1 : 0.7,
                  }}
                >
                  {editPromptSubmitting ? (
                    <span className="flex items-center gap-2">
                      <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      Starting…
                    </span>
                  ) : "Save & regenerate"}
                </button>
              );
            })()}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteVoiceoverConfirmOpen} onOpenChange={(open) => { if (!deletingVoiceover) setDeleteVoiceoverConfirmOpen(open); }}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete voiceover?</DialogTitle>
            <DialogDescription>
              This will <strong>permanently delete</strong> the original and trimmed voiceover files from storage. You&apos;ll need to regenerate them before you can assemble the video. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setDeleteVoiceoverConfirmOpen(false)}
              disabled={deletingVoiceover}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-40"
              style={{ background: "transparent", border: "1px solid var(--bd-7)", color: "var(--c-60)" }}
            >
              Cancel
            </button>
            <button
              onClick={deleteVoiceover}
              disabled={deletingVoiceover}
              className="px-4 py-2 rounded-lg text-sm font-semibold transition-all disabled:opacity-60"
              style={{ background: "oklch(0.6 0.22 25)", color: "var(--bg-page-2)" }}
            >
              {deletingVoiceover ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Deleting…
                </span>
              ) : "Delete voiceover"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
