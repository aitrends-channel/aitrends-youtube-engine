import "server-only";

// What Heclus is and how it works, for the support agent.
//
// This is the agent's product knowledge: the things a good support person knows
// without looking anything up. Live numbers — prices, promo state, quotas, one
// account's keys — are NOT here; they come from product-facts.ts and
// evidence.ts, read fresh on every question. Anything that changes must live
// there, or this file starts telling customers stale things.
//
// Rules for editing:
//   - Only write what is true of the product today. A confident wrong answer
//     from support is worse than "let me get a person".
//   - Do not describe features behind a flag or marked coming soon. A customer
//     told about something they cannot use files a ticket about it.
//   - Keep it a briefing, not a manual. Every line costs tokens on every turn.

export const PRODUCT_KNOWLEDGE = [
  "WHAT HECLUS IS",
  "Heclus turns a YouTube channel into finished videos. You point it at a channel, it studies that",
  "channel's style, then writes, illustrates, narrates and assembles new videos in that style.",
  "",
  "THE WORKFLOW, IN ORDER",
  "1. Channel — the user gives a channel URL. Heclus analyses its niche, audience, hook style, pacing",
  "   and sentence rhythm, and keeps that as the profile every later step writes against.",
  "2. Topic — Heclus proposes topics that fit the channel; the user picks one.",
  "3. Script — the script is written to the channel's profile and split into beats. A beat is one",
  "   sentence-or-two unit that gets its own image, video clip and voiceover.",
  "4. Visuals — the visual style for the video is set: look, palette, recurring characters.",
  "5. Prompts — an image prompt and a video prompt are written per beat. This is the step users edit",
  "   most; beats can be merged or split here.",
  "6. Generate — images and video clips are produced per beat, and the voiceover is synthesised.",
  "7. Assemble — clips, voiceover and captions are stitched into one video. Captions are aligned by",
  "   transcribing the voiceover, which is why an ElevenLabs key is needed even for captions.",
  "8. Thumbnails — thumbnail concepts and images, then the finished video can be downloaded.",
  "A video can be left at any step and picked up later; progress is per video.",
  "",
  "NICHES AND VIDEOS",
  "A niche is one channel's profile. Videos are made inside a niche and inherit its analysis and",
  "visual style, so a second video costs no re-analysis. Plans are sold by how many niches a user may",
  "start, and the niche counter is lifetime: deleting a niche does not give the slot back.",
  "",
  "KEYS AND WHO PAYS",
  "Users bring their own keys and pay their own providers directly. Heclus never resells credits.",
  "- KIE: scripts, channel analysis, images, video clips. Billed in KIE credits.",
  "- ElevenLabs: voiceover, and the transcription that aligns captions. Billed per character.",
  "- Anthropic (optional): a user may put their own Anthropic key in and switch the writing steps",
  "  onto it, which bills those steps to them instead of their KIE credits. Off unless they enable it.",
  "Both KIE and ElevenLabs must be saved before a niche can be started.",
  "",
  "COMMON KEY PROBLEMS, IN ORDER OF HOW OFTEN THEY HAPPEN",
  "- A truncated paste. A working KIE key is 32 characters; a working ElevenLabs key is 51 and starts",
  "  with sk_. A shorter stored value is almost always a copy that got cut off.",
  "- The wrong ElevenLabs value. Their API Keys list shows a long key ID permanently; the key itself",
  "  appears once, in the dialog right after Create or Rotate. Pasting the ID is the single most",
  "  common ElevenLabs mistake, and it cannot be converted — the key must be rotated.",
  "- Missing ElevenLabs permissions. The key needs Text to Speech, Speech to Text, Voices read and",
  "  User read. Without Voices read their own voices do not appear in the picker; without User read",
  "  their character balance cannot be shown.",
  "- KIE credits exhausted. Topped up at kie.ai; Heclus cannot add credits.",
  "",
  "VOICES",
  "Voiceovers normally take one to three seconds per beat. Much slower is usually their ElevenLabs",
  "plan rate-limiting concurrent requests. Heclus also funds a perk voice with a monthly character",
  "allowance that varies by plan, which does not touch their ElevenLabs balance.",
  "",
  "WHERE THINGS ARE",
  "- Config (/setup): API keys, the Anthropic switch, and account-level defaults.",
  "- Dashboard: Stats, API keys and usage, and Niches and Videos.",
  "- API keys and usage: whether each key is valid, KIE credit health, ElevenLabs characters left,",
  "  and what the account has spent over 30 days or all time.",
  "- Cost tab, inside a video: what that one video cost per step.",
  "- Plan (/plan): plan changes and cancellation.",
  "",
  "WHAT HECLUS CANNOT DO FOR THEM",
  "Add provider credits, change a provider's rate limits, recover a key, or see anything about their",
  "channel that YouTube does not make public. Support cannot issue refunds or extensions either —",
  "those go to a person.",
].join("\n");
