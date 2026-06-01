import { getSettings } from "@/lib/settings";

// Gemini-via-KIE for long-form text generation. We route through KIE
// using its OpenAI-compatible chat-completions endpoint (the standard
// "all providers behind one /v1/chat/completions" pattern). If KIE
// actually exposes Gemini under a different path, flip BASE_URL here.
//
// Gemini 2.5 Flash is the chosen variant — output ceiling is 65,536
// tokens (≈40k words at 1.6 tok/word) which comfortably covers
// long-form script targets that exceed Opus's 8,192-token ceiling.
const BASE_URL = "https://api.kie.ai/v1/chat/completions";

export const GEMINI_MODEL = "gemini-2.5-flash";
export const GEMINI_MAX_OUTPUT_TOKENS = 65536;

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

async function getKieKey(userId: string): Promise<string> {
  const { kie_api_key } = await getSettings(userId);
  if (!kie_api_key) throw new Error("KIE API key not configured. Add it in Settings.");
  return kie_api_key;
}

// Streams text deltas from Gemini-via-KIE. Calls onDelta for each new
// chunk of generated content. Resolves when the stream completes.
export async function streamGeminiText(opts: {
  userId: string;
  messages: ChatMessage[];
  maxTokens: number;
  onDelta: (text: string) => void;
}): Promise<void> {
  const apiKey = await getKieKey(opts.userId);

  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "heclus-engine/1.0",
    },
    body: JSON.stringify({
      model: GEMINI_MODEL,
      messages: opts.messages,
      max_tokens: Math.min(opts.maxTokens, GEMINI_MAX_OUTPUT_TOKENS),
      stream: true,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gemini stream failed (${res.status}): ${body.slice(0, 300)}`);
  }
  if (!res.body) throw new Error("Gemini stream returned no body");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") return;
      try {
        const parsed = JSON.parse(payload) as {
          choices?: { delta?: { content?: string } }[];
        };
        const text = parsed.choices?.[0]?.delta?.content;
        if (text) opts.onDelta(text);
      } catch { /* ignore partial chunk parse errors */ }
    }
  }
}
