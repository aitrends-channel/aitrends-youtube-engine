import { createHash, randomUUID } from "crypto";
import { generateTTS } from "@/lib/kie/tts";
import { uploadBuffer, userFolderFor } from "@/lib/supabase/storage";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import { dedupeOverlap } from "@/lib/text/dedupeOverlap";
import type { User } from "@supabase/supabase-js";

export const maxDuration = 800;

// Sentinel thrown when the per-batch stop check sees voiceover_stop_requested.
// Caught by the outer loop to bail cleanly without surfacing as an error.
const STOP_SENTINEL = "__voiceover_stop_requested__";

// Polls voiceover_stop_requested for this project. Throws the sentinel
// when the flag flips so the caller can break out of the batch loop.
async function assertVoiceoverRunActive(projectId: string, runId: string): Promise<void> {
  const { data } = await supabase
    .from("projects")
    .select("voiceover_active_run_id, voiceover_stop_requested")
    .eq("id", projectId)
    .single();
  if (!data) throw new Error("Project disappeared mid-run");
  // A different run took over — fail fast so we don't write under it.
  if (data.voiceover_active_run_id !== runId) throw new Error(STOP_SENTINEL);
  if (data.voiceover_stop_requested === true) throw new Error(STOP_SENTINEL);
}

// Per-beat TTS generation. Streams SSE updates so the UI can track each
// beat's status (queued → done | failed) without polling. Each beat's
// audio uploads to R2 at userFolder/projectId/voiceovers/beat-N_TS.mp3
// and the beat row is updated with the URL, voice id (for voice-change
// detection), script hash (for stale detection on script edits), and
// the new status.
//
// Batching: TTS_BEAT_BATCH_SIZE env var (defaults to 5). Each Generate
// request processes EXACTLY ONE batch and then ends — the user clicks
// the Generate button again to start the next batch. This gates KIE
// spend behind explicit confirmation per batch rather than letting one
// click run the entire script. Within a batch, all members run
// concurrently. Lower the batch size on ElevenLabs Free / Starter
// tiers or if KIE proxies start returning 429s.

interface BeatRow {
  beat_number: number;
  script_segment: string | null;
  voiceover_url: string | null;
  voiceover_status: string | null;
  voiceover_voice_id: string | null;
  voiceover_script_hash: string | null;
}

function hashSegment(text: string): string {
  return createHash("sha256").update(text.trim()).digest("hex");
}


/** Returns the subset of beats that need regeneration. A beat is stale
 *  when any of:
 *    - it has no voiceover_url
 *    - its current status is "failed" or "queued" (orphaned from a
 *      prior cancelled run)
 *    - its voiceover_voice_id differs from the requested voice
 *    - its voiceover_script_hash differs from the current script hash
 */
function selectStaleBeats(beats: BeatRow[], voiceId: string): BeatRow[] {
  return beats.filter((b) => {
    if (!b.script_segment?.trim()) return false; // skip blank
    if (!b.voiceover_url) return true;
    if (b.voiceover_status === "failed" || b.voiceover_status === "queued") return true;
    if (b.voiceover_voice_id !== voiceId) return true;
    if (b.voiceover_script_hash !== hashSegment(b.script_segment)) return true;
    return false;
  });
}

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const body = await req.json().catch(() => ({})) as {
    projectId?: string;
    voiceId?: string;
    beatNumbers?: number[];
    /** Per-beat regen path: skip the voiceover_active_run_id claim and
     *  the stop-flag polling so this request runs independently of any
     *  bulk run in flight, and the page's serverGenerationActive stays
     *  unaffected. Single-beat regens still mark the beat row as
     *  "generating" so the UI can show a spinner on that specific row. */
    skipRunClaim?: boolean;
  };
  if (!body.projectId || !body.voiceId) {
    return new Response(JSON.stringify({ error: "projectId and voiceId are required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const projectId = body.projectId;
  const voiceId = body.voiceId;
  const explicitBeats = body.beatNumbers && body.beatNumbers.length > 0 ? new Set(body.beatNumbers) : null;
  const skipRunClaim = body.skipRunClaim === true;

  // Beats are processed in fixed-size batches (default 10). Within each
  // batch every beat runs in parallel; the next batch isn't even marked
  // "queued" until the current one finishes. This keeps the UI honest:
  // a beat only shows the orange "Queued" pill when it's actually next
  // up. Beats outside the current batch stay in the grey "Pending"
  // state by virtue of having voiceover_status = NULL in the DB and the
  // UI defaulting null → "pending" in effectiveStatus().
  const BATCH_SIZE = Math.max(1, parseInt(process.env.TTS_BEAT_BATCH_SIZE ?? "5", 10));

  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        let closed = false;
        const send = (data: object) => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); }
          catch { closed = true; }
        };
        // Heartbeat — TTS calls can sit silent for 20-60s per beat and
        // intermediate proxies (Vercel edge, CDNs) drop quiet streams
        // around 30s. A keepalive comment every 15s keeps the channel
        // warm without confusing the SSE parser (lines that don't start
        // with `data: ` are ignored by the client).
        const heartbeat = setInterval(() => {
          if (closed) return;
          try { controller.enqueue(encoder.encode(": keepalive\n\n")); }
          catch { closed = true; }
        }, 15_000);

        // Generated outside the try so the finally block can release
        // the run by id even if the try threw before setting it.
        const runId = randomUUID();
        try {
          // skipRunClaim=true is the per-beat regen path: don't touch
          // voiceover_active_run_id / voiceover_stop_requested at all
          // so this request runs in parallel with any bulk run and
          // the page's serverGenerationActive flag stays unaffected.
          // We still update tts_voice_id so a regen with a different
          // voice updates the project's saved default.
          if (skipRunClaim) {
            await supabase
              .from("projects")
              .update({ tts_voice_id: voiceId })
              .eq("id", projectId)
              .eq("user_id", user.id);
          } else {
            // Claim the run. Sets the new id, clears any stale stop flag
            // from a prior cancelled run, and updates the project's
            // default voice so reassemblies and future regen runs default
            // to the same voice.
            await supabase
              .from("projects")
              .update({
                tts_voice_id: voiceId,
                voiceover_active_run_id: runId,
                voiceover_stop_requested: false,
              })
              .eq("id", projectId)
              .eq("user_id", user.id);
          }

          // Load beats with the columns we need to decide staleness.
          const { data: rawBeats, error: beatsErr } = await supabase
            .from("project_beats")
            .select("beat_number, script_segment, voiceover_url, voiceover_status, voiceover_voice_id, voiceover_script_hash")
            .eq("project_id", projectId)
            .order("beat_number");
          if (beatsErr) throw new Error(`Failed to load beats: ${beatsErr.message}`);
          const allBeats = (rawBeats ?? []) as BeatRow[];
          if (!allBeats.length) throw new Error("No beats found — generate prompts first.");

          // Two selection paths:
          //  • Explicit beatNumbers in the body — regen exactly those
          //    (e.g. a "retry failed" button).
          //  • Otherwise auto-select all stale beats. Done beats with
          //    matching voice + script hash are intentionally excluded
          //    so a bulk regen never overwrites a working voiceover.
          const candidates = allBeats.filter((b) =>
            explicitBeats ? explicitBeats.has(b.beat_number) : true,
          );
          const toGenerate = explicitBeats
            ? candidates.filter((b) => b.script_segment?.trim())
            : selectStaleBeats(candidates, voiceId);

          // Diagnostic log so worker / Vercel logs make the
          // "preserved vs regenerated" decision auditable. Without it,
          // a user wondering "did my done beats get touched?" has
          // nothing to inspect.
          const preserved = allBeats.length - toGenerate.length;
          console.log(
            `[tts-beats] project=${projectId} explicit=${explicitBeats ? Array.from(explicitBeats).join(",") : "no"} ` +
              `regen=${toGenerate.length} preserve=${preserved} ` +
              `(beats=${toGenerate.map((b) => b.beat_number).join(",") || "none"})`,
          );

          if (toGenerate.length === 0) {
            send({ type: "status", message: "All beats already up to date." });
            send({ type: "done", generated: 0, total: allBeats.length });
            closed = true;
            clearInterval(heartbeat);
            try { controller.close(); } catch { /* already done */ }
            return;
          }

          // Reset any orphaned "queued" or "generating" rows back to
          // NULL ("pending" in the UI) BEFORE we start batching. Rows
          // can be left in those states by (a) an older run that used
          // the now-removed upfront pre-mark pass, or (b) any run that
          // was cancelled / errored mid-stream. Without this reset,
          // beats outside the current batch would still render with
          // their stale "Queued" pill even though no work is happening
          // on them.
          await supabase
            .from("project_beats")
            .update({ voiceover_status: null, voiceover_error: null })
            .eq("project_id", projectId)
            .is("voiceover_url", null)
            .in("voiceover_status", ["queued", "generating"]);

          // Process ALL stale beats in this single request, BATCH_SIZE
          // at a time. The route loops server-side so a browser refresh
          // doesn't kill the queue — the original SSE stream is gone
          // but the function keeps running (maxDuration=800). Between
          // batches we poll voiceover_stop_requested; when the client's
          // Stop button PATCHes it true, the next batch never starts.
          const totalToGenerate = toGenerate.length;
          send({
            type: "status",
            message: `Generating ${totalToGenerate} beat${totalToGenerate === 1 ? "" : "s"} (${BATCH_SIZE} at a time)…`,
          });
          send({ type: "progress", current: 0, total: totalToGenerate });

          let completed = 0;
          let succeeded = 0;
          let failed = 0;
          let stoppedEarly = false;

          // Index every beat by number so processBeat can look up the
          // previous beat's script_segment (which may itself have been
          // generated in a much earlier run) for the overlap-dedupe step.
          const beatsByNumber = new Map<number, BeatRow>();
          for (const b of allBeats) beatsByNumber.set(b.beat_number, b);

          async function processBeat(beat: BeatRow) {
            const rawSegment = (beat.script_segment ?? "").trim();
            if (!rawSegment) {
              completed++;
              send({ type: "progress", current: completed, total: totalToGenerate });
              return;
            }
            // Defensive: trim any leading overlap with the previous beat
            // so we don't repeat the boundary phrase in the audio. The
            // stored script_segment stays unchanged.
            const prevBeat = beatsByNumber.get(beat.beat_number - 1);
            const segment = dedupeOverlap(rawSegment, prevBeat?.script_segment ?? null);
            if (segment !== rawSegment) {
              console.log(
                `[tts-beats] beat ${beat.beat_number} trimmed overlap with beat ${beat.beat_number - 1}: ` +
                  `"${rawSegment.slice(0, 40)}…" → "${segment.slice(0, 40)}…"`,
              );
            }
            // Safety net: if the trim produced nothing (entire beat was
            // duplicate), keep the raw text — better to ship a repeat
            // than silence.
            const ttsText = segment || rawSegment;
            try {
              send({ type: "beat", beatNumber: beat.beat_number, status: "generating" });
              await supabase
                .from("project_beats")
                .update({ voiceover_status: "generating" })
                .eq("project_id", projectId)
                .eq("beat_number", beat.beat_number);
              const audioBuf = await generateTTS(ttsText, voiceId, undefined, undefined, user.id);
              // Hash the RAW segment (matches what selectStaleBeats
              // checks). Hashing the dedup'd text would cause every
              // regen to recompute the hash differently if the previous
              // beat changed, so we'd never call it "up to date".
              const scriptHash = hashSegment(rawSegment);
              const storagePath = `${userFolderFor(user)}/${projectId}/voiceovers/beat-${beat.beat_number}_${Date.now()}.mp3`;
              const publicUrl = await uploadBuffer(storagePath, audioBuf, "audio/mpeg");
              const { error: updErr } = await supabase
                .from("project_beats")
                .update({
                  voiceover_url: publicUrl,
                  voiceover_status: "done",
                  voiceover_voice_id: voiceId,
                  voiceover_script_hash: scriptHash,
                  voiceover_error: null,
                })
                .eq("project_id", projectId)
                .eq("beat_number", beat.beat_number);
              if (updErr) throw new Error(`DB update failed: ${updErr.message}`);
              succeeded++;
              send({ type: "beat", beatNumber: beat.beat_number, status: "done", url: publicUrl });
            } catch (e) {
              const message = e instanceof Error ? e.message : "TTS failed";
              console.error(`[tts-beats] beat ${beat.beat_number} failed:`, message);
              failed++;
              await supabase
                .from("project_beats")
                .update({ voiceover_status: "failed", voiceover_error: message })
                .eq("project_id", projectId)
                .eq("beat_number", beat.beat_number);
              send({ type: "beat", beatNumber: beat.beat_number, status: "failed", error: message });
            } finally {
              completed++;
              send({ type: "progress", current: completed, total: totalToGenerate });
            }
          }

          // Walk through every stale beat BATCH_SIZE at a time. The
          // stop check between batches lets the user halt without
          // killing the in-flight batch. Per-beat regen (skipRunClaim)
          // doesn't participate in the stop-flag system, so we skip
          // the check on that path.
          for (let i = 0; i < toGenerate.length; i += BATCH_SIZE) {
            if (!skipRunClaim) {
              try {
                await assertVoiceoverRunActive(projectId, runId);
              } catch (e) {
                if (e instanceof Error && e.message === STOP_SENTINEL) {
                  stoppedEarly = true;
                  break;
                }
                throw e;
              }
            }
            const batch = toGenerate.slice(i, i + BATCH_SIZE);
            // Mark batch as queued — the UI shows the orange Queued
            // pill on these specific beats only, so users can see
            // exactly what's "up next".
            await Promise.all(
              batch.map((b) =>
                supabase
                  .from("project_beats")
                  .update({ voiceover_status: "queued", voiceover_error: null })
                  .eq("project_id", projectId)
                  .eq("beat_number", b.beat_number),
              ),
            );
            for (const b of batch) {
              send({ type: "beat", beatNumber: b.beat_number, status: "queued" });
            }
            await Promise.all(batch.map((b) => processBeat(b)));
          }

          send({
            type: "done",
            generated: succeeded,
            failed,
            total: totalToGenerate,
            remaining: stoppedEarly ? totalToGenerate - completed : 0,
            stopped: stoppedEarly,
          });
        } catch (err) {
          // STOP_SENTINEL bubbling up from inside the loop is treated
          // as a clean stop, not an error.
          if (err instanceof Error && err.message === STOP_SENTINEL) {
            send({ type: "done", generated: 0, failed: 0, total: 0, remaining: 0, stopped: true });
          } else {
            send({ type: "error", message: err instanceof Error ? err.message : "Generation failed" });
          }
        } finally {
          // Per-beat path never claimed the run id, so there's nothing
          // to release. Bulk path: release the run id (and clear the
          // stop flag) only if we still own it. If another run took
          // over (shouldn't happen but be safe), don't clobber its
          // claim.
          if (!skipRunClaim) {
          const { data: ownerCheck } = await supabase
            .from("projects")
            .select("voiceover_active_run_id")
            .eq("id", projectId)
            .single();
          if (ownerCheck?.voiceover_active_run_id === runId) {
            await supabase
              .from("projects")
              .update({ voiceover_active_run_id: null, voiceover_stop_requested: false })
              .eq("id", projectId)
              .eq("user_id", user.id);
          }
          } // end !skipRunClaim
          closed = true;
          clearInterval(heartbeat);
          try { controller.close(); } catch { /* already done */ }
        }
      },
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    },
  );
}
