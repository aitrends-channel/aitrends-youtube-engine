// KIE image models reject prompts past a model-specific maximum with
// "KIE 500: The text length cannot exceed the maximum limit". Unlike a
// 429 this is deterministic — retrying the identical prompt fails the
// same way — so recovery means SHORTENING the prompt. We retry at
// progressively smaller caps; the floor (400) sits comfortably under
// every KIE image model's limit.
export const PROMPT_LENGTH_CAPS = [1500, 800, 400];

export function isPromptLengthError(msg: string): boolean {
  return /text length|maximum limit|too long|prompt.*exceed/i.test(msg);
}

// Cap a prompt to `max` chars, preferring to cut at the last sentence/
// clause/word boundary so the truncated prompt still reads cleanly.
export function capPrompt(prompt: string, max: number): string {
  if (prompt.length <= max) return prompt;
  const slice = prompt.slice(0, max);
  const cut = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf(", "), slice.lastIndexOf(" "));
  return (cut > max * 0.5 ? slice.slice(0, cut) : slice).trim();
}

// Run a KIE submit with automatic shorten-and-retry on a length
// rejection. `run` receives the base prompt capped a little tighter on
// each attempt and is responsible for appending any suffix that must
// survive truncation (thumbnail text overlay, character-consistency
// text) — that's why the ladder lives at the call site instead of inside
// submitImageTask/generateImage: capping the already-assembled prompt
// would cut the suffix off first. Non-length errors propagate
// immediately; so does a length error once the caps are exhausted.
export async function withPromptLengthRetry<T>(
  base: string,
  run: (prompt: string) => Promise<T>
): Promise<T> {
  // Drop caps that wouldn't actually shorten the prompt (caps descend,
  // so each candidate need only be compared with its predecessor) —
  // otherwise a short-but-rejected prompt burns retries on identical
  // submits.
  const attempts = [base, ...PROMPT_LENGTH_CAPS.map((c) => capPrompt(base, c))]
    .filter((p, i, all) => i === 0 || p.length < all[i - 1].length);

  for (let i = 0; i < attempts.length; i++) {
    try {
      return await run(attempts[i]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (i === attempts.length - 1 || !isPromptLengthError(msg)) throw err;
      console.warn(`[kie] prompt rejected at ${attempts[i].length} chars, retrying at ${attempts[i + 1].length}`);
    }
  }
  // Unreachable: the loop either returns or throws on its last attempt.
  throw new Error("Prompt length retry exhausted");
}
