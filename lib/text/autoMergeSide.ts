import { getAnthropicClient, SYSTEM_PROMPT } from "@/lib/claude/client";
import { resolveModelForUser } from "@/lib/claude/models";
import { extractToolInputFromText } from "@/lib/claude/textFallback";
import { retryClaudeCall } from "@/lib/claude/retry";
import type { MergeDirection, PlanBeat } from "./mergePlan";

// Which neighbour each stub beat should join, decided by Claude in one call.
//
// A stub reads naturally on one side and awkwardly on the other ("But wait."
// belongs with the line before it; "Listen." with the line after), and only
// the surrounding narration says which. Rules can't tell — hence the model.
//
// Returns a map of beat number → side. Beats missing from the map fall back to
// the caller's default, so a partial or failed answer degrades to a normal
// bulk merge rather than an error.

const decisionsSchema = {
  type: "object" as const,
  properties: {
    decisions: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          beat: { type: "number" as const, description: "The stub beat's number" },
          join: { type: "string" as const, enum: ["before", "after"], description: "Which neighbour it should join" },
        },
        required: ["beat", "join"],
      },
    },
  },
  required: ["decisions"],
};

export async function decideMergeSides(
  userId: string,
  beats: PlanBeat[],
  stubs: PlanBeat[],
): Promise<Map<number, MergeDirection>> {
  const out = new Map<number, MergeDirection>();
  if (stubs.length === 0) return out;

  const byNumber = new Map(beats.map((b) => [b.beatNumber, (b.scriptSegment ?? "").trim()]));
  const cases = stubs.map((s) => ({
    beat: s.beatNumber,
    before: byNumber.get(s.beatNumber - 1) ?? "",
    stub: (s.scriptSegment ?? "").trim(),
    after: byNumber.get(s.beatNumber + 1) ?? "",
  }));

  const prompt = [
    "Each case below is a very short beat from a video script that will be merged into one of its neighbours.",
    "Decide which side it belongs on so the merged narration reads naturally.",
    'Answer "before" to join the preceding line, "after" to join the following one.',
    "A trailing fragment or aside belongs with the line before it; a lead-in or setup belongs with the line after it.",
    "If a neighbour is empty, pick the side that exists. Return one decision per case.",
    "",
    ...cases.map((c) => [
      `Case beat ${c.beat}:`,
      `  before: ${c.before || "(none)"}`,
      `  stub:   ${c.stub || "(empty)"}`,
      `  after:  ${c.after || "(none)"}`,
    ].join("\n")),
  ].join("\n");

  try {
    const { client } = await getAnthropicClient(userId, "script");
    const model = await resolveModelForUser(userId, "script");
    const call = () => client.messages.create({
      ...model,
      max_tokens: 2048,
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: [{ name: "save_merge_sides", description: "Save which neighbour each stub beat joins", input_schema: decisionsSchema }],
      tool_choice: { type: "tool", name: "save_merge_sides" },
      messages: [{ role: "user", content: prompt }],
    });

    const res = await retryClaudeCall("beats/merge:auto-side", call, 3);
    const toolUse = res.content.find((b) => b.type === "tool_use");
    // KIE occasionally ignores tool_choice and emits the JSON as text — same
    // fallback the other structured calls use.
    const raw = toolUse?.type === "tool_use"
      ? toolUse.input
      : extractToolInputFromText(res.content.map((b) => (b.type === "text" ? b.text : "")).join("\n"));

    const decisions = (raw as { decisions?: unknown } | null)?.decisions;
    if (!Array.isArray(decisions)) return out;
    for (const d of decisions) {
      const beat = (d as { beat?: unknown }).beat;
      const join = (d as { join?: unknown }).join;
      if (typeof beat !== "number" || !Number.isInteger(beat)) continue;
      if (join === "before") out.set(beat, "up");
      else if (join === "after") out.set(beat, "down");
    }
  } catch (e) {
    console.warn("[beats/merge] auto side decision failed, falling back:", e instanceof Error ? e.message : e);
  }

  return out;
}
