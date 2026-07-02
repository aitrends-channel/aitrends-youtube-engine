export const DEMO_DATA = {
  channel: {
    name: "FinanceFuel",
    url: "https://youtube.com/@financefuel",
    subscribers: "124K",
    avgViews: "18K",
  },

  // Top-10 sets keyed by the channel-step contentType pick (long /
  // shorts / both). Mirrors the real flow's API-side filtering — the
  // user picks a content type on the demo channel page, runs the
  // analysis, and the top-videos table renders the matching set.
  //
  // Shape mirrors the actual flow's TopVideo: { videoId, title,
  // viewCount, duration (ISO 8601), publishedAt (ISO date),
  // hasCaptions, wordCount }. Long durations stay under 45min avg so
  // the demo path doesn't trip the long-video consent modal. Shorts
  // sit under 60s. The "both" set is a top-by-views mix that skews
  // shorts-heavy (shorts typically rack up far higher view counts on
  // finance channels) with long-form holdovers at the top.
  channelTopVideos: {
    long: [
      { videoId: "t1",  title: "How I Saved $50,000 in 2 Years on a $60K Salary",            viewCount: 1840000, duration: "PT12M42S", publishedAt: "2026-02-14T09:00:00Z", hasCaptions: true,  wordCount: 2104 },
      { videoId: "t2",  title: "Stop Paying These 7 Fees — You Don't Have To",                viewCount: 1120000, duration: "PT9M08S",  publishedAt: "2026-03-22T09:00:00Z", hasCaptions: true,  wordCount: 1532 },
      { videoId: "t3",  title: "The Exact Budget That Got Me Out of $40K Debt",               viewCount:  980000, duration: "PT15M21S", publishedAt: "2025-11-05T09:00:00Z", hasCaptions: true,  wordCount: 2418 },
      { videoId: "t4",  title: "Index Funds vs ETFs — The Answer Nobody Gives You",           viewCount:  760000, duration: "PT11M30S", publishedAt: "2026-01-08T09:00:00Z", hasCaptions: true,  wordCount: 1884 },
      { videoId: "t5",  title: "Why 90% of Americans Will Never Build Real Wealth",           viewCount:  640000, duration: "PT13M55S", publishedAt: "2025-12-12T09:00:00Z", hasCaptions: false, wordCount: 2196 },
      { videoId: "t6",  title: "The Roth IRA Mistake That Cost Me $32,000",                   viewCount:  540000, duration: "PT14M08S", publishedAt: "2026-04-04T09:00:00Z", hasCaptions: true,  wordCount: 2287 },
      { videoId: "t7",  title: "House Hacking: How I Live Free in a $480K Property",          viewCount:  470000, duration: "PT18M24S", publishedAt: "2026-03-09T09:00:00Z", hasCaptions: true,  wordCount: 3014 },
      { videoId: "t8",  title: "I Lived on $1,200/Month for a Year — What I Learned",         viewCount:  410000, duration: "PT16M50S", publishedAt: "2025-10-18T09:00:00Z", hasCaptions: false, wordCount: 2731 },
      { videoId: "t9",  title: "The 3-Step Plan That Doubled My Net Worth in 18 Months",      viewCount:  380000, duration: "PT11M55S", publishedAt: "2025-09-26T09:00:00Z", hasCaptions: true,  wordCount: 1953 },
      { videoId: "t10", title: "Why Side Hustles Are Mostly a Scam (and the Ones That Work)", viewCount:  330000, duration: "PT13M20S", publishedAt: "2025-08-14T09:00:00Z", hasCaptions: true,  wordCount: 2168 },
    ],
    shorts: [
      { videoId: "s1",  title: "The 3-fund portfolio in 45 seconds",                          viewCount: 4220000, duration: "PT44S", publishedAt: "2026-03-30T09:00:00Z", hasCaptions: true,  wordCount: 132 },
      { videoId: "s2",  title: "Your bank is paying you 0.01%. Move it. Now.",                 viewCount: 3580000, duration: "PT38S", publishedAt: "2026-04-02T09:00:00Z", hasCaptions: true,  wordCount: 118 },
      { videoId: "s3",  title: "Stop buying coffee? Wrong advice. Here's the real fix.",       viewCount: 2940000, duration: "PT57S", publishedAt: "2026-02-28T09:00:00Z", hasCaptions: true,  wordCount: 168 },
      { videoId: "s4",  title: "How much you actually need in your emergency fund",            viewCount: 2110000, duration: "PT52S", publishedAt: "2026-01-19T09:00:00Z", hasCaptions: false, wordCount: 156 },
      { videoId: "s5",  title: "The one credit card rule nobody tells you",                    viewCount: 1740000, duration: "PT41S", publishedAt: "2025-12-08T09:00:00Z", hasCaptions: true,  wordCount: 124 },
      { videoId: "s6",  title: "The single line item that doubled my savings rate",            viewCount: 1600000, duration: "PT49S", publishedAt: "2026-04-12T09:00:00Z", hasCaptions: true,  wordCount: 146 },
      { videoId: "s7",  title: "If you make under $80k, ignore this advice",                   viewCount: 1400000, duration: "PT36S", publishedAt: "2026-03-15T09:00:00Z", hasCaptions: true,  wordCount: 108 },
      { videoId: "s8",  title: "Roth vs Traditional IRA in 60 seconds",                        viewCount: 1200000, duration: "PT60S", publishedAt: "2026-02-04T09:00:00Z", hasCaptions: true,  wordCount: 178 },
      { videoId: "s9",  title: "Why your 401k match is non-negotiable",                        viewCount:  980000, duration: "PT32S", publishedAt: "2025-11-22T09:00:00Z", hasCaptions: true,  wordCount: 96  },
      { videoId: "s10", title: "The credit score myth that's costing you money",               viewCount:  870000, duration: "PT47S", publishedAt: "2025-10-30T09:00:00Z", hasCaptions: false, wordCount: 142 },
    ],
    both: [
      { videoId: "s1",  title: "The 3-fund portfolio in 45 seconds",                          viewCount: 4220000, duration: "PT44S",    publishedAt: "2026-03-30T09:00:00Z", hasCaptions: true,  wordCount: 132 },
      { videoId: "s2",  title: "Your bank is paying you 0.01%. Move it. Now.",                 viewCount: 3580000, duration: "PT38S",    publishedAt: "2026-04-02T09:00:00Z", hasCaptions: true,  wordCount: 118 },
      { videoId: "s3",  title: "Stop buying coffee? Wrong advice. Here's the real fix.",       viewCount: 2940000, duration: "PT57S",    publishedAt: "2026-02-28T09:00:00Z", hasCaptions: true,  wordCount: 168 },
      { videoId: "s4",  title: "How much you actually need in your emergency fund",            viewCount: 2110000, duration: "PT52S",    publishedAt: "2026-01-19T09:00:00Z", hasCaptions: false, wordCount: 156 },
      { videoId: "t1",  title: "How I Saved $50,000 in 2 Years on a $60K Salary",            viewCount: 1840000, duration: "PT12M42S", publishedAt: "2026-02-14T09:00:00Z", hasCaptions: true,  wordCount: 2104 },
      { videoId: "s5",  title: "The one credit card rule nobody tells you",                    viewCount: 1740000, duration: "PT41S",    publishedAt: "2025-12-08T09:00:00Z", hasCaptions: true,  wordCount: 124 },
      { videoId: "s6",  title: "The single line item that doubled my savings rate",            viewCount: 1600000, duration: "PT49S",    publishedAt: "2026-04-12T09:00:00Z", hasCaptions: true,  wordCount: 146 },
      { videoId: "s7",  title: "If you make under $80k, ignore this advice",                   viewCount: 1400000, duration: "PT36S",    publishedAt: "2026-03-15T09:00:00Z", hasCaptions: true,  wordCount: 108 },
      { videoId: "s8",  title: "Roth vs Traditional IRA in 60 seconds",                        viewCount: 1200000, duration: "PT60S",    publishedAt: "2026-02-04T09:00:00Z", hasCaptions: true,  wordCount: 178 },
      { videoId: "t2",  title: "Stop Paying These 7 Fees — You Don't Have To",                viewCount: 1120000, duration: "PT9M08S",  publishedAt: "2026-03-22T09:00:00Z", hasCaptions: true,  wordCount: 1532 },
    ],
  },

  // Mocked per-step usage totals for DemoStepCostCard. Keys mirror the
  // real workflow's StepCostCard `column` prop so the demo card can
  // share the same column-naming contract.
  //
  // Demo expresses every step in the same unified KIE-credit metric so
  // the cost card displays one consistent number across the flow
  // (mirrors what a billed user actually sees in their dashboard,
  // where underlying Supadata / Claude / ElevenLabs costs are
  // converted into KIE credits). Numbers are realistic-looking for a
  // single mid-sized FinanceFuel-style video — heavy on image/video
  // gen, lighter on text steps.
  costs: {
    channel_analysis: { kie: 8.4 },
    topic:            { kie: 1.5 },
    script:           { kie: 6.2 },
    visuals:          { kie: 3.1 },
    prompts:          { kie: 4.8 },
    voiceover:        { kie: 12.6 },
    generate:         { kie: 124.8 },
    assemble:         { kie: 2.4 },
    thumbnail:        { kie: 28.2 },
  } as const,

  analysisSteps: [
    { label: "Scanning",   sublabel: "" },
    { label: "Processing", sublabel: "" },
    { label: "Refining",   sublabel: "" },
    { label: "Finalising", sublabel: "" },
  ],

  styleProfile:
    "FinanceFuel delivers personal finance content with a fast-paced, no-fluff style — opening with a sharp hook that challenges conventional money wisdom before delivering actionable steps backed by real numbers. The tone is conversational yet authoritative, blending relatable middle-class scenarios with aspirational outcomes to keep viewers engaged through the full runtime.",

  videoIdeas: [
    "How Did Ancient Humans Name Their Children?",
    "The 12,000-Year-Old Word Every Human Still Understands",
    "What Ancient Humans Actually Died From (It Wasn't What You Think)",
    "The First Song Ever Sung — And Why We Still Hum It",
    "Why Every Ancient Civilization Feared Left-Handedness",
  ],

  script: `You don't remember being named.

Think about that for a second. The single word that will follow you through every doorway, every classroom, every love letter, every hospital form, every gravestone — you had absolutely no say in it. Someone leaned over a crib, or a fire, or a bundle of moss, and made a sound. And that sound became you.

There's no birth certificate. There's no baby book. There's no aunt on a group chat suggesting something French.

It's roughly 40,000 years ago. You're a human — anatomically identical to us, same brain, same lungs, same capacity for love and grief and stupid jokes. A woman you'll one day call mother is holding you. She hasn't slept properly in weeks. The fire is low. The others are watching. And at some point in the next few days, or maybe the next few years, she is going to open her mouth and give you a sound that means you.

Wait. How did she choose it?

Not from a book. Not from a saint. Not from a cousin who died in a war that hadn't been invented yet. She reached into something — memory, weather, animal, ancestor, dream — and pulled out a syllable. And that syllable stuck.

This is the story of how humans first learned to name each other. And by the end of this video, I promise you'll never think about your own name the same way again.

Let's back up.

Because the question sounds simple, but it isn't. Naming a child is one of the strangest things our species does. It's a decision made entirely by other people, about a person who cannot yet object, using a symbolic technology — language — that took us hundreds of thousands of years to develop. Every human alive today is walking around wearing a sound that someone else chose for them. And that sound, in almost every culture we've ever studied, is treated as sacred.

That's not nothing. That's a species-level pattern.

If you want to go deeper on any of these — especially habit three, because the real math on car financing is genuinely disturbing — drop a comment below and I'll make a dedicated video. And if this was useful, the subscribe button is right there. It costs you nothing, and it keeps content like this coming.`,

  visualProfile: {
    palette: ["#f7f2ea", "#1c1c1c", "#c94a3d", "#d9c9ad", "#f0d15c"],
    paletteLabels: ["Paper background", "Bold outline", "Red accent", "Warm beige", "Highlight yellow"],
    style: "Simple 2D flat cartoon explainer aesthetic — bald stick figures with dot eyes on warm paper-colored backgrounds. Bold hand-drawn outlines and flat color fills carry the whole visual language; single-idea-per-frame compositions with prop-driven symbolism rather than photorealism.",
    thumbnailPattern: "Central stick figure with a single loud prop (question mark, red X, glowing halo), one bold hand-drawn label word floating in the frame, off-white or beige background.",
    editingPace: "Deliberate — average shot length 4-6 seconds, giving each illustrated beat room to land. Cuts on narrative breath, not on beat.",
    musicMood: "Warm acoustic underscore, sparse — piano, soft strings, small silences before the biggest ideas.",
    artStyle: "Hand-drawn childlike flat cartoon: bald stick figures, dot eyes, bold outlines, flat color fills, warm paper-colored backgrounds",
    lightingStyle: "Flat — no shading, no cast shadows. Warm firelight or overcast paper tones instead of directional lighting",
    cameraStyle: "Static hold with subtle push-in or drift; each beat sits on-screen long enough to read the drawing",
    mood: "Curious, patient, quietly wondrous — an unhurried invitation to think about something obvious that turns out to be strange",
  },

  fakeScreenshots: [
    {
      videoId: "v1",
      title: "The 12,000-Year-Old Word Every Human Still Understands",
      thumbnailUrl: "/demo/visual-analysis/stick-figure-cross-legged.jpeg",
      frameUrls: [
        "/demo/visual-analysis/stick-figure-road-fork.jpeg",
        "/demo/visual-analysis/stick-figure-confused-map.jpeg",
      ],
    },
    {
      videoId: "v2",
      title: "What Ancient Humans Actually Died From (It Wasn't What You Think)",
      thumbnailUrl: "/demo/visual-analysis/stick-figure-flexing-exhausted.jpeg",
      frameUrls: [
        "/demo/visual-analysis/stick-figure-lies-on-ground.jpeg",
        "/demo/visual-analysis/stick-figure-slams-alarm.jpeg",
      ],
    },
    {
      videoId: "v3",
      title: "The First Song Ever Sung — And Why We Still Hum It",
      thumbnailUrl: "/demo/visual-analysis/stick-figures-working-table.jpeg",
      frameUrls: [
        "/demo/visual-analysis/stick-figures-reach.jpeg",
        "/demo/visual-analysis/stick-figure-shocked-unread.jpeg",
      ],
    },
  ],

  promptBeats: [
    {
      beat: 1,
      imageUrl: "/demo/images/Gemini_Generated_Image_6e55gj6e55gj6e55.png",
      videoUrl: "/demo/videos/PixVerse_V6_Image_Text_360P_A_splitscreen_comp.mp4",
      imagePrompt: "Split screen: pile of coins on left, empty wallet on right, dramatic cinematic lighting with purple accent glow",
      videoPrompt: "Slow push-in on the split screen, slight rack focus from coins to empty wallet",
    },
    {
      beat: 2,
      imageUrl: "/demo/images/Gemini_Generated_Image_b8var0b8var0b8va.png",
      videoUrl: "/demo/videos/PixVerse_V6_Image_Text_360P_A_concerned_person.mp4",
      imagePrompt: "Person staring at laptop showing bank statement, late night, dim lamp light, concerned expression, shallow depth of field",
      videoPrompt: "Subtle handheld drift to the right, subject stays sharp while background softly blurs",
    },
    {
      beat: 3,
      imageUrl: "/demo/images/Gemini_Generated_Image_s4y61cs4y61cs4y6.png",
      videoUrl: "/demo/videos/PixVerse_V6_Image_Text_360P_A_futuristic_anima.mp4",
      imagePrompt: "Animated bar chart rising steeply, dark background, glowing purple data bars, futuristic financial dashboard aesthetic",
      videoPrompt: "Quick zoom-out from a single bar to the full chart, then freeze on peak",
    },
    {
      beat: 4,
      imageUrl: "/demo/images/Gemini_Generated_Image_urxej0urxej0urxe.png",
      videoUrl: "/demo/videos/PixVerse_V6_Image_Text_360P_A_surreal_macro_sh.mp4",
      imagePrompt: "Stack of credit cards melting into liquid, surreal macro photography, warm orange and red tones, studio lighting",
      videoPrompt: "Slow downward tilt revealing the melting base, held for two seconds",
    },
  ],

  imagePrompts: [
    "Split screen: pile of coins on left, empty wallet on right, dramatic cinematic lighting with purple accent glow",
    "Person staring at laptop showing bank statement, late night, dim lamp light, concerned expression, shallow depth of field",
    "Animated bar chart rising steeply, dark background, glowing purple data bars, futuristic financial dashboard aesthetic",
    "Stack of credit cards melting into liquid, surreal macro photography, warm orange and red tones, studio lighting",
  ],

  // Prompts step uses this longer beat list — 59 beats matching the
  // "How Did Ancient Humans Name Their Children?" script. Kept
  // separate from promptBeats above so the generate/assemble demo
  // steps keep working with their 4-item asset set; only prompts/page
  // reads from here to show the full range the real workflow produces.
  promptStepBeats: buildPromptStepBeats(),

  thumbnailConcepts: [
    {
      position: 1,
      title: "Who Chose Your Name?",
      visualConcept: "Stick-figure adult peering into a crib, giant question mark hovering above the baby. Warm beige background, single bold hand-drawn label.",
      textOverlay: "WHO CHOSE YOUR NAME?",
      emotionTrigger: "Instant self-recognition — viewers realize they've never really thought about this",
      stylePrompt: "Flat cartoon stick figures, dot eyes, bold outlines, warm beige paper background, oversized red question mark, hand-drawn label across the top",
      imageUrl: "/demo/thumbnail/thumbnail-1.png",
    },
    {
      position: 2,
      title: "40,000 Years Ago",
      visualConcept: "Prehistoric stick-figure mother by a small campfire cradling a swaddled baby, silhouette of a savanna hill behind. Bold time-stamp label.",
      textOverlay: "40,000 YEARS AGO",
      emotionTrigger: "Curiosity spike — the deep-time framing signals a big historical reveal",
      stylePrompt: "Warm beige and firelight tones, prehistoric stick figures in hide wraps, small campfire, oversized time-label across the top of frame",
      imageUrl: "/demo/thumbnail/thumbnail-2.png",
    },
    {
      position: 3,
      title: "The First Word for You",
      visualConcept: "Prehistoric mother stick-figure mouth open in an O, wavy sound-waves flowing into a glowing baby with a halo. Single-syllable speech bubble.",
      textOverlay: "THE FIRST WORD FOR YOU",
      emotionTrigger: "Wonder — the visual of the first sound of a name being spoken",
      stylePrompt: "Flat cartoon mother-and-baby, wavy sound-wave lines, glowing yellow halo around the baby, warm firelight backdrop, hand-drawn label",
      imageUrl: "/demo/thumbnail/thumbnail-3.png",
    },
    {
      position: 4,
      title: "No Book. No Saint. No Aunt.",
      visualConcept: "Three panels crossed out with red X marks — a closed book, a haloed saint figure, a smartphone with chat bubbles. Bold striking label.",
      textOverlay: "NO BOOK. NO SAINT. NO AUNT.",
      emotionTrigger: "Frame-flip — the modern crutches for naming didn't exist, so how did anyone name anyone?",
      stylePrompt: "Three side-by-side flat cartoon icons each crossed out with a bold red X, clean beige background, oversized punchy label along the top",
      imageUrl: "/demo/thumbnail/thumbnail-4.png",
    },
    {
      position: 5,
      title: "One Sound. Forever You.",
      visualConcept: "Modern stick figure staring at their own name inside a floating speech bubble, radiating yellow insight lines behind them. Meditative pause.",
      textOverlay: "ONE SOUND. FOREVER YOU.",
      emotionTrigger: "Existential recognition — the video's payoff line in a single frame",
      stylePrompt: "Modern stick figure with dot eyes wide open, name-shape floating in a speech bubble, glowing yellow radiating insight lines, clean warm background",
      imageUrl: "/demo/thumbnail/thumbnail-5.png",
    },
  ],
};

// ── Prompts-step long beat list ─────────────────────────────────────────
// One-per-beat image prompts for the "How Did Ancient Humans Name Their
// Children?" demo script. Paired with rotating short motion cues so the
// video-prompts tab has meaningful content per beat instead of blank
// strings. Assembled at module load and exposed via
// DEMO_DATA.promptStepBeats.

const DEMO_PROMPT_STEP_IMAGE_PROMPTS: string[] = [
  "Simple 2D flat cartoon illustration of a bald round-headed stick figure adult with dot eyes and a puzzled expression, tapping their temple with one finger, thought bubble above containing a large red question mark, clean white background, bold outlines and flat color fills, explainer-video aesthetic.",
  "Simple 2D flat cartoon illustration of a bald stick figure sitting cross-legged with chin resting on fist in a thinker pose, dot eyes closed in concentration, small swirl above head indicating thought, clean white background, hand-drawn childlike style with bold outlines.",
  "Simple 2D flat cartoon illustration of a bald stick figure walking through a simple rectangular wooden doorway, a floating speech bubble containing a squiggly word-shape trailing behind them like a tag on a string, muted beige background, clean bold outlines.",
  "Simple 2D flat cartoon illustration of a small bald stick figure child sitting at a wooden school desk in front of a green chalkboard, holding up a name card, other tiny stick figure classmates seated nearby, warm beige floor, flat colors.",
  "Simple 2D flat cartoon illustration of a bald stick figure with dot eyes and a small smile holding an open envelope with a red heart seal, a folded letter peeking out showing a squiggly signature at the bottom, soft peach background, hand-drawn childlike style.",
  "Simple 2D flat cartoon illustration of a bald stick figure in a clinical setting holding a clipboard with a form showing labeled blank lines, a red cross symbol floating in the corner of the frame, clean white background with light blue accents, minimalistic style.",
  "Simple 2D flat cartoon illustration of a single rounded gray gravestone standing in muted green grass, a squiggly line etched across it representing an inscribed name, a small flat cartoon flower resting at its base, soft overcast sky background, minimal detail.",
  "Simple 2D flat cartoon illustration of a swaddled baby stick figure with dot eyes lying in a simple bassinet, a large red X mark hovering above them, arms raised in tiny helpless gesture, clean white background, bold outlines, explainer-video style.",
  "Simple 2D flat cartoon illustration of a bald adult stick figure bending forward at the waist over a simple wooden crib, dot eyes gazing down, a swaddled baby figure visible inside, warm beige interior background, hand-drawn childlike style.",
  "Simple 2D flat cartoon illustration of a bald stick figure squatting beside a small crackling campfire with warm orange and yellow flame shapes and radiating glow lines, leaning forward toward a small bundle on the ground, deep navy nighttime background.",
  "Simple 2D flat cartoon illustration of a small mossy green bundle resting on the earth with a tiny swaddled baby face peeking out, surrounded by simple leaves and a couple of small stones, muted green and tan background, minimalistic hand-drawn style.",
  "Simple 2D flat cartoon illustration of a bald adult stick figure with mouth open in a small O shape, wavy sound-wave lines radiating outward from their lips like ripples, clean white background, bold outlines, explainer-video aesthetic.",
  "Simple 2D flat cartoon illustration of a wavy sound-wave arrow flowing from the left toward a small bald stick figure child on the right, with a glowing yellow radiating halo around the child indicating identity, clean beige background, flat colors.",
  "Simple 2D flat cartoon illustration of a rectangular paper birth certificate with decorative border and blank lines, overlaid with a large bold red X mark across it, clean white background, iconographic explainer style.",
  "Simple 2D flat cartoon illustration of a small pastel-colored baby memory book with a tiny footprint icon on its cover, marked with a bold red X across it, clean white background, minimal childlike detail.",
  "Simple 2D flat cartoon illustration of a smartphone screen showing chat bubbles with a tiny Eiffel Tower icon inside one bubble, a bald stick figure aunt avatar in a corner, whole phone crossed out with a large red X, clean white background.",
  "Simple 2D flat cartoon illustration of a large bold hand-drawn label reading 40,000 YEARS AGO with a small backward-pointing arrow beside it, a tiny silhouette of a savanna hill and a distant campfire below, warm beige and tan background.",
  "Simple 2D flat cartoon illustration of two bald stick figures standing side by side, one wearing a simple animal-hide wrap and the other wearing a modern t-shirt, an equals sign between them, clean white background, bold outlines.",
  "Simple 2D flat cartoon illustration of a simple pink cartoon brain shape floating centered in frame with a small glowing yellow halo of radiating lines around it, clean white background, iconographic childlike style.",
  "Simple 2D flat cartoon illustration of a pair of simple pink cartoon lungs shown centered in frame with small blue arrows indicating inhale and exhale, clean white background, minimal iconographic detail.",
  "Simple 2D flat cartoon illustration of two bald stick figures embracing in a gentle hug, a bright red heart floating above their heads with a soft warm glow, muted peach background, hand-drawn childlike style.",
  "Simple 2D flat cartoon illustration of a single bald stick figure kneeling with head bowed and dot eyes closed, a single blue teardrop falling from their face, muted gray-blue background, minimal detail.",
  "Simple 2D flat cartoon illustration of two bald stick figures laughing with wide open curved mouths and small squiggle lines around their heads indicating giggles, a small banana peel on the ground between them, clean white background, playful bold outlines.",
  "Simple 2D flat cartoon illustration of a bald prehistoric woman stick figure in a simple animal-hide wrap cradling a swaddled baby against her chest, seated on the ground, warm beige and tan cave interior background, hand-drawn style.",
  "Simple 2D flat cartoon illustration of the same prehistoric woman stick figure with dark half-circle shadows under her dot eyes, tiny Z letters floating away crossed out with small red X marks, muted beige background, minimal detail.",
  "Simple 2D flat cartoon illustration of a small dwindling campfire with only a few short orange flame shapes and thin curls of gray smoke rising, glowing embers on the ground, deep navy nighttime background, minimal warm glow.",
  "Simple 2D flat cartoon illustration of three bald prehistoric stick figures in simple hide wraps standing in a semicircle in the background, all dot eyes turned toward the viewer, warm beige and tan cave background with dim firelight.",
  "Simple 2D flat cartoon illustration of a small calendar-like row of three tan squares each showing a simple sun icon, a small arrow pointing rightward along them, clean beige background, iconographic childlike style.",
  "Simple 2D flat cartoon illustration of a small bald child stick figure shown growing taller in three stages left to right, small forward arrows between each stage, warm beige background, hand-drawn childlike style.",
  "Simple 2D flat cartoon illustration of the prehistoric mother stick figure with her mouth open in a soft O shape, gentle wavy sound-wave lines radiating from her lips toward a small swaddled baby in her arms, warm firelight glow.",
  "Simple 2D flat cartoon illustration of a tiny swaddled baby stick figure with a bright yellow glowing halo of radiating lines around them, a small arrow labeled YOU pointing directly at them, clean beige background, iconographic style.",
  "Simple 2D flat cartoon illustration of a bald stick figure narrator holding up one hand palm-out in a stop gesture, dot eyes wide open, a small exclamation mark floating above their head, clean white background, bold outlines.",
  "Simple 2D flat cartoon illustration of the prehistoric mother stick figure with dot eyes looking upward, a large red question mark floating above her head, warm beige background with faint firelight glow, hand-drawn childlike style.",
  "Simple 2D flat cartoon illustration of a closed hardcover book with a plain brown cover sitting centered in frame, overlaid with a large bold red X mark across it, clean white background, iconographic style.",
  "Simple 2D flat cartoon illustration of a bald stick figure with a small golden halo above their head and hands folded in front, overlaid with a large bold red X mark, clean white background, minimal iconographic style.",
  "Simple 2D flat cartoon illustration of a small gray gravestone with a tiny crossed-swords icon etched on it, overlaid with a large bold red X mark and a small clock symbol showing the concept of not-yet-happened, clean beige background.",
  "Simple 2D flat cartoon illustration of the prehistoric mother stick figure reaching one arm forward into a soft glowing swirling cloud of muted color, dot eyes focused, warm beige background, hand-drawn childlike style.",
  "Simple 2D flat cartoon illustration of a small cloud-shaped thought bubble containing a faint silhouette of an older stick figure ancestor, floating centered in frame, clean beige background, minimalistic iconographic style.",
  "Simple 2D flat cartoon illustration of a simple gray cloud with a few zigzag yellow lightning bolts and small blue raindrops falling below it, clean sky-blue background, iconographic childlike style.",
  "Simple 2D flat cartoon illustration of a simplified brown four-legged animal shape resembling a deer with small antlers, standing in profile centered in frame, muted green grass beneath, clean beige background, hand-drawn childlike style.",
  "Simple 2D flat cartoon illustration of a faded translucent bald stick figure elder with a small curly outline of hair and dot eyes closed, standing behind and slightly above a solid figure, ghostly presence, muted beige background.",
  "Simple 2D flat cartoon illustration of a sleeping bald stick figure lying on the ground with dot eyes as small curves, a cloud-shaped dream bubble above containing tiny stars and a crescent moon, deep navy nighttime background.",
  "Simple 2D flat cartoon illustration of the prehistoric mother stick figure holding up a small glowing speech bubble between her fingertips containing a single squiggly syllable-shape, warm yellow glow around it, beige background.",
  "Simple 2D flat cartoon illustration of a small squiggly syllable-shape in a speech bubble firmly attached to a swaddled baby stick figure by a bold line, tiny motion marks around it suggesting it snapped into place, clean beige background.",
  "Simple 2D flat cartoon illustration of a wide banner-style title card showing three bald prehistoric stick figures standing together, each with a small speech bubble containing a different squiggly name-shape floating above them, warm beige savanna background.",
  "Simple 2D flat cartoon illustration of a simple horizontal progress bar with a small arrow near the right end, above it a tiny play-triangle icon, clean white background, iconographic explainer style.",
  "Simple 2D flat cartoon illustration of a modern bald stick figure viewer staring at their own name written in a squiggly line inside a floating speech bubble beside their head, dot eyes wide in realization, small yellow radiating lines of insight, clean white background.",
  "Simple 2D flat cartoon illustration of a bald stick figure narrator taking a step backward with one foot lifted, a curved leftward-pointing arrow behind them, clean white background, bold outlines, hand-drawn childlike style.",
  "Simple 2D flat cartoon illustration of two side-by-side question marks: a small tidy black one on the left with a green checkmark labeled SIMPLE, and a large tangled scribbled red one on the right labeled with a red X, clean white background.",
  "Simple 2D flat cartoon illustration of a bald adult stick figure holding a swaddled baby, a large squiggly speech bubble with a name-shape hovering above, small orbiting question marks and swirl lines around them suggesting strangeness, clean beige background.",
  "Simple 2D flat cartoon illustration of three bald adult stick figures standing in a semicircle pointing inward toward a single swaddled baby in the center, each with a small speech bubble containing a different squiggly name-suggestion, clean white background.",
  "Simple 2D flat cartoon illustration of a swaddled baby stick figure with a small speech bubble above containing only a large red X, tiny arms raised in a helpless shrug, clean white background, minimal iconographic style.",
  "Simple 2D flat cartoon illustration of a floating cluster of simple symbols including a squiggle, a triangle, a small drawing of a hand, and a labeled tag reading LANGUAGE, all connected by thin lines, clean white background, iconographic explainer style.",
  "Simple 2D flat cartoon illustration of a long horizontal timeline arrow stretching across the frame with three small bald stick figures at different points progressing from a hunched early figure to an upright modern one, small numeric labels along the line, clean beige background.",
  "Simple 2D flat cartoon illustration of a small crowd of five bald stick figures walking together in a row, each with a distinct squiggly name-shape floating in a speech bubble tethered above their head like a tag, clean beige background, hand-drawn childlike style.",
  "Simple 2D flat cartoon illustration of a simple flat globe icon centered in frame with several small speech bubbles containing different squiggly name-shapes floating around it at various positions, muted sky-blue background, iconographic style.",
  "Simple 2D flat cartoon illustration of a single glowing squiggly name-shape inside a speech bubble resting on a small pedestal, warm yellow radiating halo lines around it, two tiny bald stick figures kneeling on either side with heads bowed, muted beige background.",
  "Simple 2D flat cartoon illustration of a bald stick figure narrator pointing emphatically at a bold hand-drawn label reading NOT NOTHING with a small green checkmark beside it, clean white background, explainer-video style.",
  "Simple 2D flat cartoon illustration of a wide grid of many small identical bald stick figures arranged in neat rows, each with a tiny speech-bubble name-tag above them, a bold hand-drawn label reading SPECIES-LEVEL PATTERN across the top, clean beige background.",
];

function buildPromptStepBeats(): { beat: number; imagePrompt: string; videoPrompt: string }[] {
  // Image + video prompts use the same per-beat description in this
  // demo's script. The real workflow can diverge them (image = look,
  // video = motion) but for the "How Did Ancient Humans Name Their
  // Children?" storyline both tabs should show the same illustrated
  // scene copy — matches what the user actually generated in their
  // script authoring pass.
  return DEMO_PROMPT_STEP_IMAGE_PROMPTS.map((prompt, i) => ({
    beat: i + 1,
    imagePrompt: prompt,
    videoPrompt: prompt,
  }));
}
