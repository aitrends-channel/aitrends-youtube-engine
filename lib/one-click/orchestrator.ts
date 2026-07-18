import { supabase } from "@/lib/supabase/client";
import { getAnthropicClient, MODEL, SYSTEM_PROMPT } from "@/lib/claude/client";
import { buildScriptPrompt } from "@/lib/claude/prompts";
import type { OneClickConfig } from "@/lib/one-click/config";

// 1Click orchestrator — advances one autopilot project by exactly one
// step per call, mirroring what each wizard page does but server-side
// and with the user's saved preferences auto-accepting every gate.
//
// The tick loop (/api/one-click/tick) fetches running projects and calls
// advanceProject on each. Keeping each call to a single step means a
// crash or timeout only loses that step's work, the next tick retries,
// and long async work (image/video generation, assembly) is polled
// across ticks rather than blocking one request.
//
// State machine (projects.current_state):
//   1–5  channel  → runs client-side at kickoff; orchestrator starts at 6
//   6    topic/script (split by selected_topic)
//   7–8  visuals
//   9–13 prompts / voiceover
//   14   generate (images + videos)
//   15   assemble → complete

const RESULT = {
  advanced: (step: string, note?: string) => ({ kind: "advanced" as const, step, note }),
  waiting: (note: string) => ({ kind: "waiting" as const, note }),
  attention: (note: string) => ({ kind: "attention" as const, note }),
  done: () => ({ kind: "done" as const }),
};
export type AdvanceResult =
  | { kind: "advanced"; step: string; note?: string }
  | { kind: "waiting"; note: string }
  | { kind: "attention"; note: string }
  | { kind: "done" };

interface ProjectRow {
  id: string;
  user_id: string;
  current_state: number;
  selected_topic: string | null;
  script: string | null;
  channel_analysis: unknown;
  content_type: string | null;
  auto_pilot_config: OneClickConfig | null;
}

// Steps the orchestrator can't yet drive on its own. Rather than hang,
// it flags needs_attention with a clear, actionable message so the user
// can finish that step in the normal wizard (and Stop/continue).
const MANUAL_STEP_NOTE = (step: string) =>
  `1Click has taken your project through to the ${step} step. Finish the remaining steps in the editor — full automation of ${step} onward is rolling out shortly.`;

/**
 * Advance one project by a single step. Returns what happened so the
 * tick loop can update auto_pilot_status/error and decide whether to
 * keep ticking this project.
 */
export async function advanceProject(project: ProjectRow): Promise<AdvanceResult> {
  const cfg = project.auto_pilot_config;
  if (!cfg) return RESULT.attention("Missing 1Click configuration for this run.");

  const state = project.current_state ?? 1;

  // ── Topic (state 6, no topic yet) ────────────────────────────────
  if (state === 6 && !project.selected_topic) {
    // Manual mode: pause for the user to choose. The run resumes on a
    // later tick once selected_topic is set (in the topic UI).
    if (cfg.topicMode === "manual") {
      return RESULT.attention("Pick a topic to continue — 1Click resumes automatically once you choose one.");
    }
    // Auto mode: channel analysis already generated video_ideas at
    // kickoff. Pick the top idea as the topic.
    const { data, error } = await supabase
      .from("projects")
      .select("video_ideas")
      .eq("id", project.id)
      .single();
    if (error) return RESULT.attention(`Couldn't read generated ideas: ${error.message}`);
    const ideas = Array.isArray(data?.video_ideas) ? (data!.video_ideas as string[]) : [];
    const topic = ideas.find((t) => t && t.trim());
    if (!topic) return RESULT.attention("No topic ideas were generated — open the project and pick a topic.");

    const { error: upErr } = await supabase
      .from("projects")
      .update({ selected_topic: topic })
      .eq("id", project.id);
    if (upErr) return RESULT.attention(`Couldn't save the topic: ${upErr.message}`);
    return RESULT.advanced("topic", `Picked topic: ${topic}`);
  }

  // ── Script (state 6, topic chosen) ───────────────────────────────
  if (state === 6 && project.selected_topic) {
    return await runScriptStep(project, cfg);
  }

  // ── Later steps: not yet auto-driven ─────────────────────────────
  if (state >= 7 && state <= 8) return RESULT.attention(MANUAL_STEP_NOTE("visuals"));
  if (state >= 9 && state <= 13) return RESULT.attention(MANUAL_STEP_NOTE("prompts & voiceover"));
  if (state === 14) return RESULT.attention(MANUAL_STEP_NOTE("generate"));
  if (state >= 15) return RESULT.done();

  // ── Channel not finished (shouldn't happen — runs at kickoff) ────
  return RESULT.attention("Channel analysis hasn't completed — open the project to finish setup.");
}

// Generate the script the same way the script route does (buildScriptPrompt
// + Claude), non-streaming, then persist and advance to state 7.
async function runScriptStep(project: ProjectRow, _cfg: OneClickConfig): Promise<AdvanceResult> {
  const topic = project.selected_topic!;

  const { data, error } = await supabase
    .from("projects")
    .select("channel_analysis")
    .eq("id", project.id)
    .single();
  const analysis = data?.channel_analysis as Parameters<typeof buildScriptPrompt>[0] | undefined;
  if (error || !analysis) {
    return RESULT.attention("Channel analysis is missing — can't write the script.");
  }

  let script = "";
  try {
    const { client: anthropic } = await getAnthropicClient(project.user_id, "script");
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 8192,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: buildScriptPrompt(analysis, topic) }],
    });
    script = res.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
  } catch (err) {
    return RESULT.attention(`Script generation failed: ${err instanceof Error ? err.message : "unknown error"}`);
  }
  if (!script) return RESULT.attention("The script came back empty — open the project and retry.");

  const wordCount = script.split(/\s+/).filter(Boolean).length;
  const { error: upErr } = await supabase
    .from("projects")
    .update({ script, word_count: wordCount, current_state: 7 })
    .eq("id", project.id);
  if (upErr) return RESULT.attention(`Couldn't save the script: ${upErr.message}`);

  return RESULT.advanced("script", `Wrote a ${wordCount}-word script`);
}
