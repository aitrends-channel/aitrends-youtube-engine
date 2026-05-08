import Anthropic from "@anthropic-ai/sdk";
import { getSettings } from "@/lib/settings";

export async function getAnthropicClient(userId: string): Promise<Anthropic> {
  const { anthropic_api_key } = await getSettings(userId);
  if (!anthropic_api_key) throw new Error("Anthropic API key not configured. Add it in Settings.");
  return new Anthropic({ apiKey: anthropic_api_key });
}

export const MODEL = "claude-sonnet-4-6";

export const SYSTEM_PROMPT = `You are an advanced AI YouTube Content Engine. Your purpose is to analyze YouTube channel transcripts, extract the channel's unique style DNA, and generate fully original content that matches the channel's voice, pacing, and emotional arc.

CORE RULES:
- Generate only original content — match style, NOT wording
- Never copy phrases from source transcripts
- Always produce structured JSON output when asked
- Maintain strict separation between script generation and visual content`;
