// The empty-wallet refusal, in a module a client component can import.
//
// The message itself has to be shared with the server (lib/heclus-charge.ts
// re-exports it), but that file reaches for supabase and next/server, so a
// component importing it would drag the server bundle into the browser. Only
// the string and the matcher live here.

export const OUT_OF_CREDITS_MESSAGE =
  "Out of Heclus Credits. Top up on the Balance page to keep generating.";

/**
 * Whether an error string is the empty-wallet refusal.
 *
 * Deliberately narrow. "That model runs on Heclus credits. Switch to Heclus
 * Credits funding to use it" is a funding-mode mismatch, not an empty wallet,
 * and sending that user to top up would be advice they cannot act on. Only the
 * "out of" wording matches.
 */
export function isOutOfCreditsMessage(text: string | null | undefined): boolean {
  return (text ?? "").toLowerCase().includes("out of heclus credits");
}
