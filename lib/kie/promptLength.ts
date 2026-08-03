// KIE image models reject over-long prompts with "The text length cannot
// exceed the maximum limit". It's deterministic, so recovery means
// shortening, not retrying. 400 sits under every model's limit.
export const PROMPT_LENGTH_CAPS = [1500, 800, 400];

export function isPromptLengthError(msg: string): boolean {
  return /text length|maximum limit|too long|prompt.*exceed/i.test(msg);
}

export function capPrompt(prompt: string, max: number): string {
  if (prompt.length <= max) return prompt;
  const slice = prompt.slice(0, max);
  const cut = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf(", "), slice.lastIndexOf(" "));
  return (cut > max * 0.5 ? slice.slice(0, cut) : slice).trim();
}

// Submit with shorten-and-retry. `run` gets the capped base and appends its
// own suffix (overlay text, consistency text) — capping the assembled prompt
// instead would cut that suffix off first, which is why this wraps the call
// site rather than living inside submitImageTask.
export async function withPromptLengthRetry<T>(
  base: string,
  run: (prompt: string) => Promise<T>
): Promise<T> {
  // Skip caps that wouldn't shorten anything, or a short-but-rejected prompt
  // burns retries on identical submits.
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
  throw new Error("Prompt length retry exhausted");
}
