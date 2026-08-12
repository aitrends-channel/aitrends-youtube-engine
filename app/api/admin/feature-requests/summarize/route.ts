export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-server";
import { getHeclusDirectClient } from "@/lib/claude/client";
import { retryClaudeCall } from "@/lib/claude/retry";
import { extractToolInputFromText } from "@/lib/claude/textFallback";

// Turns a support message into one line for the feature-request board.
//
// The board is only worth keeping if a row can be read at a glance, and a
// customer writing mid-problem does not produce that: real subjects on real
// tickets include "Hi", "Testing" and "17th test". So the ticket's own words go
// to the model and what comes back is a title you could put on a roadmap plus a
// couple of plain sentences.
//
// Effort is low and the schema is tight because this is a two-sentence
// summarisation and an admin is waiting on it mid-ticket. Thinking is left at
// its default, which is on: with thinking disabled, Opus 5 sometimes writes a
// tool call into its visible text instead of emitting a tool_use block, and a
// forced-tool call is exactly where that hurts.

const SUMMARY_SCHEMA = {
  type: "object" as const,
  properties: {
    title: {
      type: "string",
      description:
        "The request as a thing we could build, at most 70 characters. No ticket numbers, no greeting, no 'user wants'. Sentence case.",
    },
    notes: {
      type: "string",
      description:
        "One or two plain sentences: what they are asking for and why, in their terms. No preamble, no restating the title, no quoting the whole message.",
    },
    looksLikeRequest: {
      type: "boolean",
      description:
        "True if they are asking for something Heclus does not do yet. False if this is a bug report, a question, or a complaint about existing behaviour.",
    },
  },
  required: ["title", "notes", "looksLikeRequest"],
};

const SYSTEM =
  "You summarise Heclus support messages into feature-request entries. Heclus turns a YouTube channel into generated videos. " +
  "Be brief and plain. Write what the customer wants, not what they said. Never invent detail that is not in the message.";

export async function POST(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const body = await req.json().catch(() => ({}));
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message && !subject) {
    return NextResponse.json({ error: "Nothing to summarise." }, { status: 400 });
  }

  try {
    const client = await getHeclusDirectClient();
    const call = () => client.messages.create({
      model: "claude-opus-5",
      // Thinking is on by default on this model and shares the budget with the
      // response, so the ceiling is well above what two sentences need.
      max_tokens: 4000,
      output_config: { effort: "low" },
      system: SYSTEM,
      tools: [{
        name: "save_summary",
        description: "Record the request as one board-ready line.",
        input_schema: SUMMARY_SCHEMA,
      }],
      tool_choice: { type: "tool", name: "save_summary" },
      messages: [{
        role: "user",
        content: `Subject: ${subject || "(none)"}\n\nMessage:\n${message || "(empty)"}`,
      }],
    });

    const res = await retryClaudeCall("admin/feature-requests/summarize", call, 2);
    const toolUse = res.content.find((b) => b.type === "tool_use");
    const raw = toolUse?.type === "tool_use"
      ? toolUse.input
      : extractToolInputFromText(res.content.map((b) => (b.type === "text" ? b.text : "")).join("\n"));

    const s = raw as { title?: unknown; notes?: unknown; looksLikeRequest?: unknown } | null;
    if (!s || typeof s.title !== "string" || !s.title.trim()) {
      return NextResponse.json({ error: "The model did not return a summary." }, { status: 502 });
    }

    return NextResponse.json({
      title: s.title.trim(),
      notes: typeof s.notes === "string" ? s.notes.trim() : "",
      looksLikeRequest: s.looksLikeRequest !== false,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Could not summarise it" },
      { status: 500 },
    );
  }
}
