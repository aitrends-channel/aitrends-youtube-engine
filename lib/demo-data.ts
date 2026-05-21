export const DEMO_DATA = {
  channel: {
    name: "FinanceFuel",
    url: "https://youtube.com/@financefuel",
    subscribers: "124K",
    avgViews: "18K",
  },

  analysisSteps: [
    "Fetching channel data…",
    "Analyzing video transcripts…",
    "Extracting style DNA…",
    "Generating video ideas…",
  ],

  styleProfile:
    "FinanceFuel delivers personal finance content with a fast-paced, no-fluff style — opening with a sharp hook that challenges conventional money wisdom before delivering actionable steps backed by real numbers. The tone is conversational yet authoritative, blending relatable middle-class scenarios with aspirational outcomes to keep viewers engaged through the full runtime.",

  videoIdeas: [
    "5 Money Habits That Are Making You Poorer",
    "Why Your Emergency Fund Is the Wrong Size (And the Exact Number You Need)",
    "The Silent 401(k) Fee That's Stealing Years From Your Retirement",
    "I Tracked Every Dollar for 90 Days — Here's What Actually Changed",
    "Stop Budgeting. Do This Instead to Build Wealth Faster",
  ],

  script: `Here's the uncomfortable truth: most people who are broke aren't broke because they don't earn enough. They're broke because of five habits they do every single day without even realizing it. And the worst part? Most financial advice out there is telling you to do these things.

Let's fix that right now.

Habit number one: paying yourself last. You've heard "pay yourself first," but I'm guessing your actual bank account tells a different story. Here's what most people actually do — they pay rent, cover subscriptions, hit the grocery store, maybe go out twice, and then they save whatever's left. Which is usually nothing. The fix is brutally simple: automate a transfer to savings on the same day your paycheck hits. Even if it's $50. Especially if it's $50. You spend what's available. So make less available.

Habit number two: treating your lifestyle like it scales with income. Every time you get a raise, do you feel richer for about three weeks — then somehow end up with the same amount left over at month's end? That's lifestyle inflation, and it is silent wealth destruction. A $10,000 raise should not mean $10,000 more in annual spending. It should mean $3,000 more in spending and $7,000 more in investments. Map out what happens to every dollar of new income before you start earning it.

Habit number three: buying depreciating assets on credit. A car financed at 7.9% APR is not transportation — it's a subscription to poverty. A couch on 0% financing that you can't pay off before the promo period ends is the same trap in slower motion. Interest on things that lose value is wealth destruction in its purest form. The rule: if it goes down in value, pay cash or don't buy it.

Habit number four: ignoring the small subscriptions. You probably have between 8 and 14 active subscriptions right now. I want you to actually pull up your bank statement and count them. Most people are off by at least four. At an average of $18 per subscription, that's potentially $1,700 a year going to services you may not even use. Invested at a 9% average return, that's over $25,000 in a decade. From subscriptions you barely remember you have.

Habit number five — and this one is the most expensive — is keeping money idle in a savings account earning 0.01%. The average big-bank savings account still pays nearly nothing, even in a high-rate environment. Meanwhile, high-yield savings accounts are paying 4 to 5 percent. That's not a rounding error — on a $20,000 emergency fund, that's the difference between earning $20 per year and earning $900 per year. For doing exactly nothing different with your money.

Here's the thing about all five of these habits: none of them require willpower, a budget spreadsheet, or a complete lifestyle overhaul. They require a system. Automate the savings transfer. Set a rule for raises. Stop financing depreciation. Audit subscriptions quarterly. Move idle cash to a high-yield account.

The gap between people who build wealth and people who don't is rarely income. It's almost always these invisible habits running in the background, quietly draining the difference. Fix the system, and the results follow.

If you want to go deeper on any of these — especially habit three, because the real math on car financing is genuinely disturbing — drop a comment below and I'll make a dedicated video. And if this was useful, the subscribe button is right there. It costs you nothing, and it keeps content like this coming.`,

  visualProfile: {
    palette: ["#1a1a2e", "#7c5cbf", "#f5c842", "#e8e8e8", "#2d2d44"],
    paletteLabels: ["Background", "Accent", "Highlight", "Text", "Panel"],
    style: "Dark, high-contrast with bold typography and data-driven overlays. Thumbnails use split-screen layouts with strong directional lighting and a consistent purple/gold color language to signal premium finance content.",
    thumbnailPattern: "Bold sans-serif headline on left, punchy visual on right. Always includes a number or percentage in large type.",
    editingPace: "Fast-cut — average shot length 2.1 seconds. Hook delivered in first 8 seconds.",
    musicMood: "Tense, motivational underscore with occasional silence for emphasis.",
  },

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
};
