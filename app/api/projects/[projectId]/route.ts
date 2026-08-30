export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { deleteFolder, deleteFolderWhere, deleteObject, r2KeyFromUrl, userFolderFor } from "@/lib/supabase/storage";
import { prefixTooLongMessage } from "@/lib/prefix-limit";
import type { User } from "@supabase/supabase-js";

export async function GET(
  _req: Request,
  { params }: { params: { projectId: string } }
) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { projectId } = params;

  const [projectRes, beatsRes, thumbsRes] = await Promise.all([
    supabase.from("projects").select("*").eq("id", projectId).eq("user_id", user.id).single(),
    supabase.from("project_beats").select("*").eq("project_id", projectId).order("beat_number"),
    supabase.from("project_thumbnails").select("*").eq("project_id", projectId).order("position"),
  ]);

  if (projectRes.error) {
    return NextResponse.json({ error: projectRes.error.message }, { status: 404 });
  }

  return NextResponse.json({
    ...projectRes.data,
    beats: (beatsRes.data ?? []).map((b) => ({
      beatNumber: b.beat_number,
      scriptSegment: b.script_segment,
      imagePrompt: b.image_prompt,
      camera: b.camera,
      lighting: b.lighting,
      mood: b.mood,
      action: b.action,
      videoPrompt: b.video_prompt,
      imageUrl: b.image_url,
      videoUrl: b.video_url,
      imageStatus: b.image_status,
      imageMotion: b.image_motion ?? null,
      soundEffect: b.sound_effect ?? null,
      soundVolume: b.sound_volume ?? null,
      soundPitch: b.sound_pitch ?? null,
      transition: b.transition ?? null,
      videoStatus: b.video_status,
      imageTaskId: b.image_task_id ?? undefined,
      imageModelId: b.image_model_id ?? undefined,
      videoJobId: b.video_job_id,
      videoError: b.video_error ?? undefined,
      videoModelId: b.video_model_id ?? undefined,
      videoDuration: b.video_duration ?? undefined,
      videoAspectRatio: b.video_aspect_ratio ?? undefined,
      videoResolution: b.video_resolution ?? undefined,
      audioUrl: b.audio_url ?? undefined,
      voiceoverUrl: b.voiceover_url ?? undefined,
      voiceoverStatus: b.voiceover_status ?? undefined,
      voiceoverDurationMs: b.voiceover_duration_ms ?? undefined,
      voiceoverVoiceId: b.voiceover_voice_id ?? undefined,
      voiceoverScriptHash: b.voiceover_script_hash ?? undefined,
      voiceoverError: b.voiceover_error ?? undefined,
      voiceoverJobId: b.voiceover_job_id ?? undefined,
    })),
    thumbnails: (thumbsRes.data ?? []).map((t) => ({
      position: t.position,
      title: t.title,
      visualConcept: t.visual_concept,
      textOverlay: t.text_overlay,
      emotionTrigger: t.emotion_trigger,
      stylePrompt: t.style_prompt,
      imageUrl: t.image_url,
      imageStatus: t.image_status,
    })),
  }, {
    // Polling clients (SWR every 5s on the assemble page) need fresh
    // data to see the worker's column writes — without no-store the
    // browser/CDN HTTP cache could serve a stale response and the
    // UI wouldn't pick up new fields (e.g. assembly_preview_url
    // landing mid-assembly) until a hard refresh.
    headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
    },
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: { projectId: string } }
) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { projectId } = params;
  const body = await req.json();

  if (body.clear_images) {
    await supabase.from("project_beats").update({ image_url: null, image_status: null }).eq("project_id", projectId);
    await supabase.from("projects").update({ images_progress: 0 }).eq("id", projectId).eq("user_id", user.id);
    return NextResponse.json({ success: true });
  }

  // Bulk-run kickoff: flip the whole target set to "queued" in one write
  // so every tile the run will touch shows its in-flight indicator
  // immediately — the per-beat submit loop then upgrades each one to
  // "generating" as it actually reaches KIE.
  if (Array.isArray(body.queue_images) && body.queue_images.length > 0) {
    const beatNumbers = (body.queue_images as unknown[]).filter((n) => Number.isInteger(n));
    const { error } = await supabase
      .from("project_beats")
      .update({ image_status: "queued" })
      .eq("project_id", projectId)
      .in("beat_number", beatNumbers);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  // Bulk-run teardown: any beat still "queued" never made it to a KIE
  // submit (user stopped the run, submit threw client-side, or the tab
  // died). Reset to NULL so the tile goes back to its idle affordance
  // instead of spinning forever. "generating" beats are untouched —
  // those have real KIE tasks the reconciliation poller will finish.
  if (body.clear_queued_images) {
    const { error } = await supabase
      .from("project_beats")
      .update({ image_status: null })
      .eq("project_id", projectId)
      .eq("image_status", "queued");
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  // Wipe all image-prompt beats for this project so the prompts step can
  // start over from a clean slate. Also implicitly clears any video
  // prompts since they live on the same rows. Nulling
  // prompts_active_run_id signals any in-flight prompts route for this
  // project to abort at its next checkpoint instead of writing more
  // beats on top of the wiped state. prompts_script_hash is reset too
  // so the "Script was edited after these beats were generated" stale
  // warning on the prompts / generate pages doesn't keep firing
  // against beats that no longer exist.
  if (body.clear_image_prompts) {
    const { error: delErr } = await supabase
      .from("project_beats")
      .delete()
      .eq("project_id", projectId);
    if (delErr) return NextResponse.json({ error: delErr.message }, { status: 500 });
    await supabase
      .from("projects")
      .update({
        prompts_active_run_id: null,
        prompts_active_step: null,
        prompts_script_hash: null,
      })
      .eq("id", projectId)
      .eq("user_id", user.id);
    // Walk a completed prompts state back to "in progress". Leaving
    // current_state >= 14 with zero beats made the project read as
    // "generation done but beats missing prompts" in the prompts
    // page's completion poll if the follow-up run's SSE died before
    // the route's own walkback ran. Mirrors the .gte guard the
    // prompts route uses at run start.
    await supabase
      .from("projects")
      .update({ current_state: 13 })
      .eq("id", projectId)
      .eq("user_id", user.id)
      .gte("current_state", 14);
    return NextResponse.json({ success: true });
  }

  // Clear the prompt TEXT while keeping the beat rows. The three-step prompts
  // flow needs this: there, the beats are step 1's output — deleting them to
  // rewrite a prompt would throw away the segmentation and any merges the user
  // made, which is the work the split exists to protect.
  //
  // Video prompts go too: one written against the old image prompt describes a
  // shot that no longer exists.
  //
  // image_url / video_url are deliberately kept, same trade as migration 115 —
  // those are already-paid renders and image generation is most of what a user
  // spends. prompts_script_hash is kept as well: the segments still match the
  // script they were cut from, so nothing about them is stale.
  if (body.clear_image_prompt_text) {
    const { error: updErr } = await supabase
      .from("project_beats")
      .update({
        image_prompt: null,
        video_prompt: null,
        camera: null,
        lighting: null,
        mood: null,
        action: null,
      })
      .eq("project_id", projectId);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    await supabase
      .from("projects")
      .update({ prompts_active_run_id: null, prompts_active_step: null })
      .eq("id", projectId)
      .eq("user_id", user.id);
    await supabase
      .from("projects")
      .update({ current_state: 13 })
      .eq("id", projectId)
      .eq("user_id", user.id)
      .gte("current_state", 14);
    return NextResponse.json({ success: true });
  }

  // Wipe every prior thumbnail reference before a fresh batch is
  // uploaded/fetched. The Thumbnails step calls this at the start of
  // generateConcepts so the analysis runs on the new references only:
  //   - DB: thumbnail_analysis is the cached analysis output;
  //         nulling it forces /api/workflow/visual-analysis to re-run.
  //   - R2: thumbnail-refs/ is dedicated to manual uploads, safe to
  //         drop the whole prefix. auto-frames/ is shared with the
  //         Visuals step's frame stills, so only *-thumb.jpg keys
  //         (the auto-pulled niche thumbnails) are removed —
  //         *-frame-*.jpg files stay intact.
  if (body.clear_thumbnail_refs) {
    const userFolder = userFolderFor(user);
    try {
      await deleteFolder(`${userFolder}/${projectId}/thumbnail-refs/`);
      await deleteFolderWhere(
        `${userFolder}/${projectId}/auto-frames/`,
        (key) => key.endsWith("-thumb.jpg"),
      );
    } catch (e) {
      console.warn(`[clear_thumbnail_refs] R2 cleanup failed:`, e instanceof Error ? e.message : e);
    }
    const { error: updErr } = await supabase
      .from("projects")
      .update({ thumbnail_analysis: null })
      .eq("id", projectId)
      .eq("user_id", user.id);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  // Full downstream wipe for a script regeneration. Everything tied to
  // the previous script must be cleared so the new run starts from a
  // clean slate — image / video / voiceover files in R2, every
  // per-beat row, thumbnails, the assembled mp4, the assembly
  // checkpoint, and all status / progress / hash columns on the
  // project row. The script_* columns themselves (script, script_active_run_id)
  // are NOT touched here — handleRegenerate on the client zeroes those
  // separately before kicking off the new script stream.
  //
  // Folder wipe strategy: a single deleteFolder pass on
  // {userFolder}/{projectId}/ removes every R2 object the project ever
  // wrote (images, videos, voiceovers/, voiceover-preview-*.mp3,
  // _assembly/, the assembled mp4, legacy voiceover_*.mp3, anything
  // future code might park here). Cheaper and less brittle than chasing
  // each prefix individually.
  if (body.clear_for_script_regen) {
    const folder = `${userFolderFor(user)}/${projectId}/`;
    try {
      await deleteFolder(folder);
    } catch (e) {
      // R2 cleanup failure shouldn't block the DB reset. Orphaned
      // files cost almost nothing and will be overwritten by future
      // runs at the same keys.
      console.warn(`[clear_for_script_regen] R2 cleanup failed for ${folder}:`, e instanceof Error ? e.message : e);
    }

    const [beatsRes, thumbsRes] = await Promise.all([
      supabase.from("project_beats").delete().eq("project_id", projectId),
      supabase.from("project_thumbnails").delete().eq("project_id", projectId),
    ]);
    if (beatsRes.error) return NextResponse.json({ error: `Failed to delete beats: ${beatsRes.error.message}` }, { status: 500 });
    if (thumbsRes.error) return NextResponse.json({ error: `Failed to delete thumbnails: ${thumbsRes.error.message}` }, { status: 500 });

    const { error: updErr } = await supabase
      .from("projects")
      .update({
        // Prompts (image + video) state — match clear_image_prompts.
        prompts_active_run_id: null,
        prompts_active_step: null,
        prompts_script_hash: null,
        prompts_stop_requested: false,
        // Image / video progress counters.
        images_progress: 0,
        videos_progress: 0,
        // Legacy single-track voiceover columns.
        tts_url: null,
        tts_cleaned_url: null,
        tts_script_hash: null,
        // Per-beat voiceover hash that anchors beat_timings to a
        // specific voiceover set — invalid once audio is gone.
        beat_timings_voiceover_hash: null,
        // Assembly output + checkpoint.
        assembled_url: null,
        assembly_status: null,
        assembly_progress: null,
        assembly_error: null,
        assembly_checkpoint: null,
        assembly_stop_requested: false,
      })
      .eq("id", projectId)
      .eq("user_id", user.id);
    if (updErr) return NextResponse.json({ error: `Failed to reset project: ${updErr.message}` }, { status: 500 });

    console.log(`[clear_for_script_regen] project=${projectId} wiped R2 prefix ${folder}, all beats, all thumbnails, and 13 project columns reset.`);
    return NextResponse.json({ success: true });
  }

  // Hard-delete the assembled mp4 from R2 + wipe the related project
  // state so the assemble page resets to its pre-assembly view. Called
  // from the Reassemble confirm path on the client.
  //
  // What gets cleaned:
  //   - The single assembled_*.mp4 referenced by project.assembled_url
  //     (only when the URL is one of ours — preview-proxy URLs are
  //     skipped since they live on the worker's disk, not in R2).
  //   - The entire _assembly/ checkpoint folder for this project (clip
  //     fragments, joined/padded/mixed/captioned mp4s). These can be
  //     several MB each so we don't want them stranded.
  //
  // What gets reset on the project row:
  //   - assembled_url (the link we just deleted)
  //   - assembly_status / assembly_progress / assembly_error
  //   - assembly_checkpoint (so the next run doesn't try to skip stages)
  //   - assembly_stop_requested (defensive — fresh starts shouldn't
  //     inherit a stale stop signal)
  //
  // Errors during storage delete are logged but don't fail the
  // request — the project-row reset is the user-visible outcome and
  // worth keeping even if storage cleanup races.
  if (body.clear_assembled) {
    const { data: proj } = await supabase
      .from("projects")
      .select("assembled_url")
      .eq("id", projectId)
      .eq("user_id", user.id)
      .single();
    const assembledUrl = (proj?.assembled_url as string | null) ?? null;
    if (assembledUrl) {
      const key = r2KeyFromUrl(assembledUrl);
      if (key) {
        try { await deleteObject(key); }
        catch (e) { console.warn(`[clear_assembled] failed to delete ${key}:`, e); }
      }
    }
    try {
      const folder = `${userFolderFor(user)}/${projectId}/_assembly/`;
      await deleteFolder(folder);
    } catch (e) {
      console.warn(`[clear_assembled] failed to delete checkpoint folder:`, e);
    }
    const { error: updErr } = await supabase
      .from("projects")
      .update({
        assembled_url: null,
        assembly_status: null,
        assembly_progress: null,
        assembly_error: null,
        assembly_checkpoint: null,
        assembly_stop_requested: false,
      })
      .eq("id", projectId)
      .eq("user_id", user.id);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  // Commit the in-progress preview as the final assembled video.
  // Called when the user clicks Continue on the stopped panel that
  // shows up after they clicked "Use this version" during assembly.
  // No worker round-trip needed — mixed.mp4 is already in R2 (its
  // URL lives in assembly_preview_url) so we just promote it to
  // assembled_url and mark the assembly done. The checkpoint folder
  // is left intact; it's small and gets overwritten on the next
  // assembly run if the user reassembles.
  if (body.commit_preview) {
    const { data: proj, error: readErr } = await supabase
      .from("projects")
      .select("assembly_preview_url, assembly_status")
      .eq("id", projectId)
      .eq("user_id", user.id)
      .single();
    if (readErr) return NextResponse.json({ error: readErr.message }, { status: 404 });
    const previewUrl = (proj?.assembly_preview_url as string | null) ?? null;
    if (!previewUrl) {
      return NextResponse.json({ error: "No preview available to commit" }, { status: 400 });
    }
    const { error: updErr } = await supabase
      .from("projects")
      .update({
        assembly_status: "done",
        assembled_url: previewUrl,
        assembly_preview_url: null,
        assembly_finalize_preview_requested: false,
        assembly_stop_requested: false,
        assembly_checkpoint: null,
        assembly_progress: null,
        assembly_error: null,
        current_state: 15,
      })
      .eq("id", projectId)
      .eq("user_id", user.id);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    return NextResponse.json({ success: true, assembled_url: previewUrl });
  }

  // Abort an in-progress (or stopped) assembly: wipe the assembly
  // checkpoint, the _assembly/ R2 folder, and every assembly_* field
  // on the project — but leave assembled_url alone. The point is to
  // throw away the failed/cancelled attempt without nuking a
  // previously-successful assembled video that may already exist on
  // the project.
  //
  // Called from the Cancel button shown alongside Resume when the
  // assembly_status is "stopped" (and from anywhere we want a clean
  // slate for the next assembly attempt).
  if (body.cancel_assembly) {
    try {
      const folder = `${userFolderFor(user)}/${projectId}/_assembly/`;
      await deleteFolder(folder);
    } catch (e) {
      console.warn(`[cancel_assembly] failed to delete checkpoint folder:`, e);
    }
    const { error: updErr } = await supabase
      .from("projects")
      .update({
        assembly_status: null,
        assembly_progress: null,
        assembly_error: null,
        assembly_checkpoint: null,
        assembly_stop_requested: false,
        // Same defensive clears as the rest of the assembly state —
        // a stale preview URL or finalize flag would survive an
        // otherwise-fresh start otherwise.
        assembly_preview_url: null,
        assembly_finalize_preview_requested: false,
      })
      .eq("id", projectId)
      .eq("user_id", user.id);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  // Delete the project's voiceover(s) from R2 and wipe the related
  // fields on the project row so the Generate page returns to its
  // pre-TTS state. Both original (tts_url) and trimmed (tts_cleaned_url)
  // are removed when present. Storage errors are logged but don't
  // fail the request — the row reset is the visible outcome.
  if (body.clear_voiceover) {
    const { data: proj } = await supabase
      .from("projects")
      .select("tts_url, tts_cleaned_url")
      .eq("id", projectId)
      .eq("user_id", user.id)
      .single();
    const candidates = [proj?.tts_url as string | null, proj?.tts_cleaned_url as string | null]
      .filter((u): u is string => !!u);
    for (const url of candidates) {
      const key = r2KeyFromUrl(url);
      if (!key) continue;
      try { await deleteObject(key); }
      catch (e) { console.warn(`[clear_voiceover] failed to delete ${key}:`, e); }
    }
    const { error: updErr } = await supabase
      .from("projects")
      .update({
        tts_url: null,
        tts_cleaned_url: null,
        tts_script_hash: null,
        tts_voice_id: null,
      })
      .eq("id", projectId)
      .eq("user_id", user.id);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    return NextResponse.json({ success: true });
  }

  // Clear only video prompts; keep the beats and their image prompts.
  if (body.clear_video_prompts) {
    const { error: updErr } = await supabase
      .from("project_beats")
      .update({ video_prompt: null })
      .eq("project_id", projectId);
    if (updErr) return NextResponse.json({ error: updErr.message }, { status: 500 });
    await supabase
      .from("projects")
      .update({ prompts_active_run_id: null, prompts_active_step: null })
      .eq("id", projectId)
      .eq("user_id", user.id);
    return NextResponse.json({ success: true });
  }

  // Null clears the project's own prefix and inherits again, so only a string
  // is worth measuring. The same limit is enforced on the account default in
  // /api/settings, since either one can end up in front of every image prompt.
  if (typeof body.character_consistency_text === "string") {
    const tooLong = prefixTooLongMessage(body.character_consistency_text);
    if (tooLong) return NextResponse.json({ error: tooLong }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("projects")
    .update(body)
    .eq("id", projectId)
    .eq("user_id", user.id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(
  _req: Request,
  { params }: { params: { projectId: string } }
) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const { projectId } = params;

  // Verify project belongs to this user and fetch file URLs
  const [projectRes, beatsRes, thumbsRes] = await Promise.all([
    supabase.from("projects").select("id, tts_url").eq("id", projectId).eq("user_id", user.id).single(),
    supabase.from("project_beats").select("image_url, video_url, audio_url").eq("project_id", projectId),
    supabase.from("project_thumbnails").select("image_url").eq("project_id", projectId),
  ]);

  if (projectRes.error || !projectRes.data) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  // Collect Supabase storage paths before we drop the DB rows
  const supabaseStorageBase = `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/public/assets/`;
  const supabasePaths = [
    projectRes.data.tts_url,
    ...(beatsRes.data ?? []).flatMap((b) => [b.image_url, b.video_url, b.audio_url]),
    ...(thumbsRes.data ?? []).map((t) => t.image_url),
  ]
    .filter((url): url is string => !!url && url.startsWith(supabaseStorageBase))
    .map((url) => url.replace(supabaseStorageBase, ""));

  // DB cleanup first — children before parent. If storage cleanup later fails,
  // we leave orphan files (benign) rather than orphan DB rows (broken UI).
  const childrenRes = await Promise.allSettled([
    supabase.from("project_beats").delete().eq("project_id", projectId),
    supabase.from("project_thumbnails").delete().eq("project_id", projectId),
  ]);

  const childErrors = childrenRes
    .map((r) => r.status === "rejected" ? String(r.reason) : (r.value.error?.message ?? null))
    .filter((e): e is string => !!e);

  if (childErrors.length > 0) {
    return NextResponse.json({ error: `Failed to delete child rows: ${childErrors.join("; ")}` }, { status: 500 });
  }

  const projectDelete = await supabase.from("projects").delete().eq("id", projectId).eq("user_id", user.id);
  if (projectDelete.error) {
    return NextResponse.json({ error: projectDelete.error.message }, { status: 500 });
  }

  // Storage cleanup — best-effort, won't fail the request if it errors out
  const warnings: string[] = [];

  if (supabasePaths.length > 0) {
    const { error } = await supabase.storage.from("assets").remove(supabasePaths);
    if (error) warnings.push(`Supabase storage: ${error.message}`);
  }

  try {
    await deleteFolder(`${projectId}/`);
  } catch (err) {
    warnings.push(`R2 storage: ${err instanceof Error ? err.message : String(err)}`);
  }

  return NextResponse.json({ success: true, ...(warnings.length > 0 ? { warnings } : {}) });
}
