import type { SeedTable } from "./seed-types";

/**
 * Published prices for models the ledger has never seen.
 *
 * Hand-entered, and the only half of the seed table a person edits. A model
 * here is one nobody has run, so there is no measurement to prefer: this is
 * what the vendor's price list says. The moment a real generation lands,
 * scripts/seed-model-prices.mjs writes a measured figure into the generated
 * half and that wins from then on.
 *
 * Images are credits per generation, video is credits PER SECOND, both in the
 * vendor's own credit (kie_credits or poyo_credits, never Heclus credits).
 * Per second rather than per clip because that is what the estimate multiplies
 * by duration, and because pricing 4 resolutions against 7 clip lengths is 28
 * cells per model to say what 4 can.
 *
 * Run `node scripts/seed-model-prices.mjs` to see which models are still
 * missing. It prints them, and every entry below started life on that list.
 */
export const MANUAL_SEED: SeedTable = {
  kie: {
    image: {
      // Listed as "flux1-kontext, text-to-image, Pro / Max", per image. The
      // ids differ from ours by a digit, which is why a search for
      // "flux-kontext" returns nothing and "kontext" returns both.
      "flux-kontext-pro": { flat: 5 },
      "flux-kontext-max": { flat: 10 },
    },
    video: {
      // From kie.ai/pricing, read 2026-08-31 off the rendered table, which is
      // client-side and paginated five rows at a time behind a search box.
      // KIE quotes every video model per video, so each figure below is the
      // clip price over the SHORTEST duration that model offers: the highest
      // per-second rate it can charge, so a longer clip over-holds and gets
      // the difference back at settle rather than under-holding permanently.

      // Veo 3.1 Quality: 250 at 720p and 255 at 1080p, over a 4s clip.
      "veo3":      { byResolution: { "720p": 62.5, "1080p": 63.75 } },
      // Veo 3.1 Fast: 60 and 65 over the same 4s.
      "veo3_fast": { byResolution: { "720p": 15, "1080p": 16.25 } },
      // 55 without audio at 5s, 110 at 10s, so linear.
      "kling-2.6/image-to-video": { flat: 11 },
      // The only two rows KIE lists: 30 at 10s 720p, and 30 at 5s 1080p.
      "runway": { byResolution: { "720p": 3, "1080p": 6 } },
      // hailuo 02 Pro, 57 at 6s 1080p. The Standard 512p row is a different
      // model to the one this id serves.
      "hailuo/02-image-to-video-pro": { flat: 9.5 },
      // gemini-omni-flash, no video input: 63 at 4s for both 720p and 1080p.
      "omni-flash": { byResolution: { "720p": 15.75, "1080p": 15.75 } },
      // KIE lists no Flash row for Wan 2.6, so this is plain 2.6: 70 at 5s
      // 720p and 104.5 at 5s 1080p. Flash should cost less than the model it
      // is a fast variant of, which makes this an over-hold and refundable.
      "wan/2-6-flash-image-to-video": { byResolution: { "720p": 14, "1080p": 20.9 } },

      // Priced per second already, so no conversion. "no video" is the tier
      // without a reference clip, which is how we call it.
      "seedance-2-mini": { byResolution: { "480p": 3.8, "720p": 8.2 } },

      // Still unpriced after searching the table:
      //   sora-2-image-to-video   no Sora row on kie.ai/pricing at all
      //   genaipro-veo-2          the free-credits model, which may be
      //                           deliberately unpriced rather than missing
    },
  },
  poyo: {
    image: {},
    video: {
      // From poyo.ai/pricing, read 2026-08-31. Credits per second, keyed by
      // the id the ledger stores, which for a model reached through
      // KIE_TO_POYO_VIDEO is the KIE id rather than PoYo's own.
      //
      // Where PoYo prices per video rather than per second, the figure here is
      // the clip price divided by the SHORTEST duration that model offers.
      // That is deliberately the highest per-second rate the model can charge:
      // a longer clip then over-holds and the excess comes back at settle,
      // where under-holding is permanent because settle caps at the hold.
      //
      // Tier choice: the plain no-audio, no-reference-video tier, which is how
      // these are called. Seedance 2 is the check on that reading, since its
      // "480p without video" 20/sec is exactly what production measured.

      // 65 per video at 5s, and 130 at 10s, so genuinely linear.
      "kling-2.6/image-to-video":  { flat: 13 },
      // Veo 3.1 first tier, 20 per video at 720p and 1080p, 30 at 4K,
      // over a shortest clip of 4s.
      "veo3":                      { byResolution: { "720p": 5, "1080p": 5, "4k": 7.5 } },
      // 48 per video at 4s.
      "sora-2-image-to-video":     { flat: 12 },
      // Seedance 2.0 Mini, without reference video.
      "seedance-2-mini":           { byResolution: { "480p": 10, "720p": 24 } },
      // 120 per generation at 4s, and it climbs sublinearly from there, so the
      // 4s rate over-holds every longer clip.
      "omni-flash":                { flat: 30 },
      // Seedance 2.5, without reference video.
      "seedance-2.5":              { byResolution: { "480p": 28, "720p": 63, "1080p": 114 } },
      // 35 per video at 768p 6s, 60 at 1080p 6s.
      "hailuo-2.3":                { byResolution: { "768p": 5.83, "1080p": 10 } },
      "hailuo-03":                 { flat: 21 },
      // 42 per video at 5s, 84 at 10s.
      "kling-2.5-turbo-pro":       { flat: 8.4 },
      "kling-3.0-motion-control":  { byResolution: { "720p": 9, "1080p": 15 } },
      // Veo 3.1 Official, second tier, no audio.
      "veo3.1-fast-official":      { byResolution: { "720p": 3.6, "1080p": 6 } },

      // Hailuo 02 Pro is a fixed 65 per video, so per-second is the wrong
      // shape for it and no division is right. 6s is the shortest clip the
      // model makes, which puts the rate at its ceiling: a 10s clip then holds
      // 108 against an actual 65 and hands back the difference at settle.
      // Only 768p is listed; 512P takes the same rate rather than nothing.
      "hailuo/02-image-to-video-pro": { byResolution: { "512P": 10.83, "768P": 10.83 } },

      // Still unpriced, and not from want of looking: poyo.ai/pricing has no
      // Seedance 2 Fast row at all, only 2.5, 2.0 Mini, 2 and 1.5 Pro.
      //   bytedance/seedance-2-fast
    },
  },
};
