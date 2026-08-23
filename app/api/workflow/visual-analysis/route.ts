import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClient, getHeclusDirectClient, SYSTEM_PROMPT } from "@/lib/claude/client";
import { getVisionConfig } from "@/lib/claude/vision";
import { modelParamsFor } from "@/lib/claude/models";

export const maxDuration = 800;
import { visualProfileInputSchema } from "@/lib/claude/anthropicSchemas";
import { buildVisualAnalysisPrompt } from "@/lib/claude/prompts";
import { VisualProfileSchema, ThumbnailAnalysisSchema } from "@/lib/claude/schemas";
import { retryClaudeCall } from "@/lib/claude/retry";
import { extractToolInputFromText } from "@/lib/claude/textFallback";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { logAnthropicCost } from "@/lib/costs";
import type { User } from "@supabase/supabase-js";
import { requireActiveSubscription } from "@/lib/subscription";
import { requireWalletFunds } from "@/lib/heclus-charge";
import { estimateStepFloor, shortfallResponse } from "@/lib/credits/estimate";

// Anthropic's image `url` source rejects anything that isn't HTTPS with
// a 400 ("Only HTTPS URLs are supported"). Frame/thumbnail URLs can
// arrive malformed — protocol-less (a public bucket URL persisted when
// R2_PUBLIC_URL lost its scheme) or plain http — so coerce every URL to
// https before we build the image blocks. Anything still not an https
// URL after coercion (blob:, data:, relative paths) is dropped: better
// to analyze fewer frames than to fail the whole call on one bad entry.
function toHttpsImageUrls(urls: string[]): string[] {
  const out: string[] = [];
  for (const raw of urls) {
    // Strip a stray leading "=" (the KEY=value copy-paste slip that
    // corrupted some stored auto_frames URLs into "=https://...") before
    // any scheme handling, so it doesn't get mistaken for a scheme-less
    // host and double-prefixed into "https://=https://...".
    const trimmed = raw?.trim().replace(/^=+/, "").trim();
    if (!trimmed) continue;
    // Protocol-relative (//host/...) or scheme-less host (host/path).
    // Prepend https:// and let the URL parse below validate it.
    let candidate = trimmed;
    if (candidate.startsWith("//")) candidate = `https:${candidate}`;
    else if (candidate.startsWith("http://")) candidate = `https://${candidate.slice("http://".length)}`;
    else if (!/^[a-z][a-z0-9+.-]*:/i.test(candidate)) candidate = `https://${candidate}`;
    try {
      const u = new URL(candidate);
      if (u.protocol === "https:") out.push(u.toString());
    } catch {
      // Unparseable — skip it.
    }
  }
  return out;
}

/**
 * Reorders frame URLs so one frame from every video comes before a second
 * frame from any of them.
 *
 * The client builds the list grouped by video (videoA-frame-1, videoA-frame-2,
 * videoB-frame-1, ...), so capping with a plain slice would keep both frames
 * from the first few videos and drop the rest of the channel entirely. Ten
 * frames spread across ten videos describes a channel's visual style far
 * better than ten frames from five of them.
 *
 * Groups on the videoId in the auto-frames path. Manually uploaded images
 * don't match it and keep their original order, which is what we want.
 */
function spreadAcrossVideos(urls: string[]): string[] {
  const groups = new Map<string, string[]>();
  urls.forEach((url, i) => {
    const match = url.match(/\/auto-frames\/(.+?)-frame-\d+\.jpg/);
    const key = match ? match[1] : `ungrouped:${i}`;
    const existing = groups.get(key);
    if (existing) existing.push(url);
    else groups.set(key, [url]);
  });

  const spread: string[] = [];
  const lists = [...groups.values()];
  const deepest = Math.max(0, ...lists.map((l) => l.length));
  for (let round = 0; round < deepest; round++) {
    for (const list of lists) {
      if (list[round]) spread.push(list[round]);
    }
  }
  return spread;
}

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  const expired = requireActiveSubscription(user);
  if (expired) return expired;
  // Wallet-funded users pay for this step in credits, so an empty balance is
  // refused before any provider is called.
  const broke = await requireWalletFunds(user);
  if (broke) return broke;
  // A token step's cost is not knowable before it runs, so the check is
  // what this step has historically cost: the median across past projects.
  // Imprecise, and far better than letting a 150-credit Opus call start on
  // a balance of one. Silent when there is no history to read.
  const short = shortfallResponse(await estimateStepFloor({ userId: user.id, step: "visuals" }));
  if (short) return short;

  try {
    const { client: anthropic, routing, takeLastCreditsConsumed } = await getAnthropicClient(user.id, "visual_analysis");
    // Mutable copy of routing — when the KIE-exhausted fallback path
    // kicks in we flip this to "heclus_direct" so cost rows attribute
    // to the path that actually billed.
    let effectiveRouting = routing;
    const { projectId, videoImageUrls, thumbnailImageUrls } = await req.json() as {
      projectId: string;
      videoImageUrls?: string[];
      thumbnailImageUrls?: string[];
    };
    // Model and frame count are admin-set (Config → Anthropic → Per step,
    // Visual analysis card). Going through modelParamsFor also applies the
    // thinking pin, which this route used to skip by passing a bare model id —
    // harmless on Opus 4.7, but a model that thinks by default would have eaten
    // the max_tokens budget below.
    const vision = await getVisionConfig();
    const model = vision.model;

    // Normalize to https up-front so a malformed URL doesn't 400 the
    // whole Anthropic call. Recompute hasVideo/hasThumbnails off the
    // cleaned lists so we don't claim to have images we just dropped.
    const videoUrls = toHttpsImageUrls(videoImageUrls ?? []);
    const thumbnailUrls = toHttpsImageUrls(thumbnailImageUrls ?? []);
    const droppedVideo = (videoImageUrls?.length ?? 0) - videoUrls.length;
    const droppedThumbs = (thumbnailImageUrls?.length ?? 0) - thumbnailUrls.length;
    if (droppedVideo > 0 || droppedThumbs > 0) {
      console.warn(`[visual-analysis] dropped non-https image URLs — video=${droppedVideo} thumbnails=${droppedThumbs}`);
    }

    const hasVideo = videoUrls.length > 0;
    const hasThumbnails = thumbnailUrls.length > 0;
    if (!hasVideo && !hasThumbnails) {
      // Distinguish "none sent" from "all sent were malformed" so the
      // user gets an actionable message instead of a silent empty call.
      const anySent = (videoImageUrls?.length ?? 0) + (thumbnailImageUrls?.length ?? 0) > 0;
      return NextResponse.json({
        error: anySent
          ? "All image URLs were invalid (must be public HTTPS links). Refetch screenshots and try again."
          : "At least one image URL is required",
      }, { status: 400 });
    }

    // Vision tokens run ~1.6k per image at high-res, so the frame count is the
    // main driver of what this step costs. Admin-set; see migration 127.
    //
    // Applied to each list separately rather than as a combined total: the
    // schema below is built from hasVideo/hasThumbnails, so a cap that empties
    // one list would leave the model asked for a section it was given no
    // images for. A call carrying both kinds therefore sends up to 20.
    const MAX_ANALYSIS_IMAGES = vision.maxImages;
    const cappedVideoImages = spreadAcrossVideos(videoUrls).slice(0, MAX_ANALYSIS_IMAGES);
    const cappedThumbnails = thumbnailUrls.slice(0, MAX_ANALYSIS_IMAGES);

    const imageBlocks = [
      ...cappedVideoImages.map((url) => ({
        type: "image" as const,
        source: { type: "url" as const, url },
      })),
      ...cappedThumbnails.map((url) => ({
        type: "image" as const,
        source: { type: "url" as const, url },
      })),
    ];

    // Build the combined schema dynamically — only ask Claude for the
    // pieces of analysis we have inputs for. The thumbnails step calls
    // with thumbnail images only, in which case we just produce
    // thumbnail_analysis and leave visual_profile alone.
    const visualProperty = visualProfileInputSchema.properties.visualProfile;
    const thumbnailProperty = "thumbnailAnalysis" in visualProfileInputSchema.properties
      ? (visualProfileInputSchema.properties as Record<string, unknown>).thumbnailAnalysis
      : null;

    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    if (hasVideo) {
      properties.visualProfile = visualProperty;
      required.push("visualProfile");
    }
    if (hasThumbnails && thumbnailProperty) {
      properties.thumbnailAnalysis = thumbnailProperty;
      required.push("thumbnailAnalysis");
    }

    const combinedSchema = {
      type: "object" as const,
      properties,
      required,
    };

    // Single messages.create call factored out so we can run it through
    // either the KIE-mediated client or the Heclus-direct fallback
    // without duplicating the request body.
    const callModel = (client: Anthropic) =>
      client.messages.create({
        ...modelParamsFor(model),
        max_tokens: 2048,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        tools: [{
          name: "save_visual_analysis",
          description: "Save the extracted visual style profile",
          input_schema: combinedSchema,
        }],
        tool_choice: { type: "tool", name: "save_visual_analysis" },
        messages: [{
          role: "user",
          content: [
            ...imageBlocks,
            { type: "text", text: buildVisualAnalysisPrompt({ video: hasVideo, thumbnails: hasThumbnails }) },
          ],
        }],
      });

    // Run the call with 5 retries on KIE; if all 5 fail, swap to a
    // Heclus-direct Anthropic client (bypassing KIE entirely) and try
    // again with another 5 retries. KIE 500s tend to come in waves
    // that outlast our 1+2+4+8+16s backoff; direct Anthropic is the
    // safety net for those.
    const callWithFallback = async (label: string): Promise<Anthropic.Messages.Message> => {
      try {
        return await retryClaudeCall(label, () => callModel(anthropic), 5);
      } catch (kieErr) {
        console.warn(`[visual-analysis] KIE exhausted retries for ${label} — falling back to Heclus-direct Anthropic`,
          kieErr instanceof Error ? kieErr.message : kieErr);
        try {
          const directClient = await getHeclusDirectClient();
          // Drain any stale KIE credit captured by the failed attempts
          // so a half-paid KIE row doesn't get logged against the
          // successful direct call below.
          takeLastCreditsConsumed();
          effectiveRouting = "heclus_direct";
          return await retryClaudeCall(`${label} [heclus-direct]`, () => callModel(directClient), 5);
        } catch (directErr) {
          // Surface the direct error since that's what the user will see;
          // the KIE one is logged above for ops debugging.
          throw directErr;
        }
      }
    };

    // KIE+Opus occasionally ignores tool_choice and emits the JSON as
    // a text block instead of a tool_use — same pattern the prompts
    // route handles. Two attempts: a fresh call usually picks the tool
    // on the second try. On the second miss, fall through to the
    // text-mode parser (extractToolInputFromText) before giving up.
    let response!: Anthropic.Messages.Message;
    let toolUse: Anthropic.Messages.ContentBlock | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await callWithFallback(`visual analysis (try ${attempt + 1})`);
      // Log token usage per attempt — each attempt was billed, even
      // if it produced no usable tool block.
      void logAnthropicCost({
        projectId,
        userId: user.id,
        step: "visuals",
        model,
        routing: effectiveRouting,
        usage: response.usage,
        kieCreditsConsumed: takeLastCreditsConsumed(),
      });
      toolUse = response.content.find((b) => b.type === "tool_use");
      const blockTypes = response.content.map((b) => b.type).join(",");
      console.log(`[visual-analysis] attempt ${attempt + 1} stop=${response.stop_reason} blocks=${blockTypes} tool_use=${!!toolUse}`);
      if (toolUse && toolUse.type === "tool_use") break;
    }

    let result: { visualProfile?: unknown; thumbnailAnalysis?: unknown; [k: string]: unknown };
    if (toolUse && toolUse.type === "tool_use") {
      result = toolUse.input as { visualProfile?: unknown; thumbnailAnalysis?: unknown; [k: string]: unknown };
    } else {
      // Text-mode fallback. extractToolInputFromText unwraps the fake
      // `<tool_calls>` wrapper KIE+Opus likes to emit, or just grabs
      // the first top-level JSON object from the text block.
      const textBlock = response.content.find((b) => b.type === "text");
      const raw = textBlock && textBlock.type === "text" ? textBlock.text : "";
      console.log(`[visual-analysis] tool_use missing after retry — fallback parsing text len=${raw.length} head=${raw.slice(0, 200)}`);
      const parsed = extractToolInputFromText(raw);
      if (!parsed) {
        throw new Error("No visual analysis returned — model produced neither a tool call nor a parseable JSON text block. Try again.");
      }
      console.log(`[visual-analysis] text-mode fallback recovered keys=${Object.keys(parsed).join(",")}`);
      result = parsed as { visualProfile?: unknown; thumbnailAnalysis?: unknown; [k: string]: unknown };
    }

    // Pick the visualProfile from whichever shape the model returned.
    // Haiku (the vision model) sometimes:
    //   1. Wraps as { visualProfile: {...} } — happy path
    //   2. Returns the fields flat at the root — fallback to result
    //   3. Returns something else entirely (rare; logs help diagnose)
    function pickVisualProfile(): Record<string, unknown> | null {
      if (result.visualProfile && typeof result.visualProfile === "object") {
        return result.visualProfile as Record<string, unknown>;
      }
      // Flat shape — only treat the root as a visualProfile if it
      // actually has the signature fields.
      if (typeof result.artStyle === "string" && Array.isArray(result.colorPalette)) {
        return result as Record<string, unknown>;
      }
      return null;
    }

    function pickThumbnailAnalysis(): Record<string, unknown> | null {
      if (result.thumbnailAnalysis && typeof result.thumbnailAnalysis === "object") {
        return result.thumbnailAnalysis as Record<string, unknown>;
      }
      // Flat shape — only if signature fields are present and we
      // weren't also expecting a visualProfile (which would have its
      // own shape and could collide).
      if (!hasVideo && typeof result.textStyle === "string" && typeof result.composition === "string") {
        return result as Record<string, unknown>;
      }
      return null;
    }

    let visualProfileRaw: Record<string, unknown> | null = null;
    let thumbnailRaw: Record<string, unknown> | null = null;

    if (hasVideo) {
      visualProfileRaw = pickVisualProfile();
      if (!visualProfileRaw) {
        const keys = Object.keys(result).join(", ") || "(empty)";
        console.warn(`[visual-analysis] unexpected tool input keys=${keys}`);
        throw new Error(`Visual analysis returned an unrecognized shape (keys: ${keys}). Retry.`);
      }
    }
    if (hasThumbnails) {
      thumbnailRaw = pickThumbnailAnalysis();
      if (!thumbnailRaw && !hasVideo) {
        const keys = Object.keys(result).join(", ") || "(empty)";
        console.warn(`[visual-analysis] unexpected tool input keys=${keys}`);
        throw new Error(`Thumbnail analysis returned an unrecognized shape (keys: ${keys}). Retry.`);
      }
    }

    const visualProfile = visualProfileRaw ? VisualProfileSchema.parse(visualProfileRaw) : null;
    const thumbnailAnalysis = thumbnailRaw ? ThumbnailAnalysisSchema.parse(thumbnailRaw) : null;

    // Only update DB fields we actually analyzed — don't clobber
    // previously-stored values for the other axis.
    const updates: Record<string, unknown> = {};
    if (visualProfile) updates.visual_profile = visualProfile;
    if (thumbnailAnalysis) updates.thumbnail_analysis = thumbnailAnalysis;
    // current_state bump only on the visual-style branch (the original
    // step-9 gate). Thumbnail-only calls don't advance the workflow.
    if (hasVideo) updates.current_state = 9;

    if (Object.keys(updates).length > 0) {
      await supabase.from("projects").update(updates).eq("id", projectId).eq("user_id", user.id);
    }

    return NextResponse.json({ visualProfile, thumbnailAnalysis });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Visual analysis failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
