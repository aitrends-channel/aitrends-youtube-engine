import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-server";
import { answerSupportQuestion } from "@/lib/support-agent/agent";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Ask the agent something and see what it would say, without a customer on the
// other end. This is what makes editing the notes above a real loop rather than
// guesswork: write a note, ask the question, read the answer.
//
// It runs against the ADMIN's own account by default, so the evidence half is
// real. An email may be supplied to see what a specific customer would be told,
// which is the difference between "does it know the policy" and "would it get
// this ticket right".
//
// Nothing is filed, no chat row is created, and nothing is emailed.

export async function POST(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  const body = await req.json().catch(() => ({})) as { question?: unknown; asEmail?: unknown };
  const question = typeof body.question === "string" ? body.question.trim() : "";
  if (!question) return NextResponse.json({ error: "Ask something first." }, { status: 400 });

  const asEmail = typeof body.asEmail === "string" && body.asEmail.trim()
    ? body.asEmail.trim().toLowerCase()
    : (guard.user.email ?? "");
  if (!asEmail) return NextResponse.json({ error: "No account email to run this against." }, { status: 400 });

  try {
    const { answer } = await answerSupportQuestion({
      email: asEmail,
      question,
      channel: "chat",
    });
    return NextResponse.json({ answer, ranAs: asEmail });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "The agent failed." }, { status: 500 });
  }
}
