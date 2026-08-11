// How long a prompt prefix may be.
//
// The prefix leads every image prompt, so whatever is in it is spent again on
// every beat. Uncapped, it stops being a style note and becomes a second
// script: customers have pasted 1,000 to 3,000 characters here, which crowds
// out the per-beat description it is meant to be introducing and pushes the
// assembled prompt past what the image models accept. PROMPT_LENGTH_CAPS
// shortens the base prompt when KIE rejects one, but never the prefix, so an
// over-long prefix survives every retry and fails all of them. The customer
// sees every image fail with no reason given.
//
// 500 clears every prefix written so far that reads like a style note (the
// longest were 154, 393 and 499 characters) and holds the worst assembled
// prompt under 2,000, inside the first retry cap.
export const PREFIX_MAX_CHARS = 500;

/** The message to show when a prefix is too long to save, or null if it fits. */
export function prefixTooLongMessage(text: string): string | null {
  const n = text.trim().length;
  if (n <= PREFIX_MAX_CHARS) return null;
  return `That prefix is ${n.toLocaleString()} characters. Keep it under ${PREFIX_MAX_CHARS}. It is a short style note added to the front of every image prompt, not a script, so describe only what should never change and leave each scene to Heclus.`;
}
