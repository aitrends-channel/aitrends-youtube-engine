// The ElevenLabs models a voiceover can be spoken on.
//
// Its own module because the voiceover page needs this list to render the
// picker, and lib/kie/tts.ts reaches for the database, the funding mode and the
// product keys the moment it is imported. A client component pulling the
// catalog out of there would drag all of that into the browser bundle.

import { USD_PER_CREDIT } from "@/lib/credit-unit";

/** What a voiceover runs on when nobody has chosen otherwise. Unchanged from
 *  when this was the only option, so an existing project sounds the same. */
export const TTS_MODEL = "eleven_turbo_v2_5";

/** The ElevenLabs models a customer may pick between.
 *
 *  Two tiers, and the price is the whole decision: Flash and Turbo bill at half
 *  the rate of Multilingual and v3. A ten-minute narration is roughly 9,000
 *  characters, so the gap is real but small per video and large across a
 *  channel. `perKChars` is USD per 1,000 characters and mirrors lib/pricing.ts,
 *  which is what the wallet actually charges against. */
export const TTS_MODELS: { id: string; label: string; note: string; perKChars: number }[] = [
  { id: "eleven_turbo_v2_5",     label: "Turbo v2.5",     note: "The default. Fast, natural, cheapest tier.",            perKChars: 0.05 },
  { id: "eleven_flash_v2_5",     label: "Flash v2.5",     note: "Fastest to generate. Flatter delivery on long reads.",  perKChars: 0.05 },
  { id: "eleven_multilingual_v2",label: "Multilingual v2",note: "Steadier across accents and non-English. Twice the price.", perKChars: 0.10 },
  { id: "eleven_v3",             label: "v3",             note: "Most expressive, and the least predictable. Twice the price.", perKChars: 0.10 },
];

/** What a model costs the wallet per 1,000 characters.
 *
 *  Derived from the USD rate rather than written down beside it, and using the
 *  same conversion lib/pricing.ts bills with, so the number on the button and
 *  the number on the ledger cannot drift apart. */
export function ttsCreditsPerKChars(perKChars: number): number {
  return perKChars / USD_PER_CREDIT;
}

export function isSelectableTtsModel(id: unknown): id is string {
  return typeof id === "string" && TTS_MODELS.some((m) => m.id === id);
}

/** An id from a project row, or the default when it is unset or no longer in
 *  the catalog. A model retired from the list must not reach ElevenLabs. */
export function ttsModelOr(id: unknown): string {
  return isSelectableTtsModel(id) ? id : TTS_MODEL;
}
