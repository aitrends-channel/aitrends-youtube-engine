// What a credit movement is called, where a customer reads it.
//
// The ledger stores a note written at charge time, "image_gen · 2 poyo_credits"
// or "channel_analysis · beats 7-11 · 0.05 kie_credits", and the rows were being
// labelled from the provider instead: "Spent on anthropic", "Spent on kie". That
// is our word for our supplier. Nobody buying credits knows which of their steps
// is anthropic, and three quarters of a page reading "Spent on anthropic" says
// nothing about where the money went.

const STEP_LABEL: Record<string, string> = {
  channel_analysis:  "Channel analysis",
  topic:             "Video ideas",
  script:            "Script writing",
  visuals:           "Visual style",
  prompts_image:     "Image prompts",
  prompts_video:     "Video prompts",
  tts:               "Voiceover",
  image_gen:         "Image generation",
  video_gen:         "Video clips",
  assemble:          "Final assembly",
  thumbnail:         "Thumbnails",
  thumbnail_concept: "Thumbnail concepts",
  thumbnail_image:   "Thumbnails",
};

const PROVIDER_LABEL: Record<string, string> = {
  anthropic:  "Anthropic",
  kie:        "KIE",
  poyo:       "PoYo",
  elevenlabs: "ElevenLabs",
  supadata:   "Supadata",
};

/** The step a note names, or null when it names none. The note's first segment
 *  is the step; everything after it is the beat span and the units. */
export function stepFromNote(note: string | null | undefined): string | null {
  const first = (note ?? "").split(" · ")[0]?.trim();
  return first ? first : null;
}

/** Which beats one charge covered, where the note recorded them. */
export function beatsFromNote(note: string | null | undefined): string | null {
  const m = /(?:^|·)\s*beats?\s+(\d+)(?:-(\d+))?/i.exec(note ?? "");
  if (!m) return null;
  return m[2] && m[2] !== m[1] ? `beats ${m[1]}-${m[2]}` : `beat ${m[1]}`;
}

/**
 * One row's label: what it bought, not who we bought it from.
 *
 * Falls back through the raw step tidied up, then to the provider with its own
 * capitalisation, then to "Spent". A step this file has no name for is still a
 * real charge, and printing it raw is better than hiding it behind a supplier.
 */
export function creditRowLabel(
  kind: string, note: string | null | undefined, provider: string | null | undefined,
): string {
  switch (kind) {
    case "topup":      return "Credits purchased";
    case "refund":     return "Refunded";
    case "adjustment": return "Credits granted";
  }
  const step = stepFromNote(note);
  if (step) {
    const named = STEP_LABEL[step];
    if (named) {
      const beats = beatsFromNote(note);
      return beats ? `${named} · ${beats}` : named;
    }
    return step.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  }
  const p = (provider ?? "").trim();
  return p ? `Spent on ${PROVIDER_LABEL[p] ?? p}` : "Spent";
}
