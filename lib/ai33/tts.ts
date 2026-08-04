import type { KieModel } from "@/lib/types";
import { getFreeUsageThisMonth } from "@/lib/freeUsage";
import { supabase } from "@/lib/supabase/client";
import { isAdminUser } from "@/lib/admin";
import { AI33_TTS_CAP_STARTER, AI33_TTS_CAP_PRO, resolveQuotaCap } from "@/lib/quota-config";

// ai33.pro (OpenSpeaker) TTS — a Heclus-paid voiceover perk, mirroring the
// Qwen path (lib/replicate/tts.ts). It runs on HECLUS's own ai33 key
// (server-side AI33_API_TOKEN), users configure nothing, and a per-user
// monthly character cap keeps one account from draining the perk.
//
// ai33 is a multi-provider TTS aggregator: a voice_id already carries a
// provider prefix (minimax_, elevenlabs_, edge_, kokoro_, vbee_,
// fishaudio_, clone_). We add our OWN "ai33/" prefix on top so
// generateTTS can route on it and it can't collide with ElevenLabs/qwen/
// google ids; generateAi33TTS strips "ai33/" before calling the API.
//
// The API is async: POST /v3/text-to-speech returns a task_id, then we
// poll the task endpoint until the audio URL is ready and download it —
// wrapped to satisfy generateTTS's synchronous { audio, charsConsumed }
// contract, exactly like the Qwen path blocks on Replicate.

// Every message on this class can reach a customer — via a toast on
// preview, or the SSE error during generation. The provider is our
// supplier, not something users should ever read, and upstream messages
// get passed through verbatim, so scrub at the boundary rather than
// trusting each call site. Server logs keep the real name.
const PROVIDER_NAME = /\bai33(\.pro)?\b|\bopenspeaker\b/gi;
function scrubProvider(message: string): string {
  return message.replace(PROVIDER_NAME, "the free voice service").trim();
}

export class Ai33TTSError extends Error {
  constructor(message: string, public status?: number) {
    super(scrubProvider(message));
    // Neutral runtime name: anything that stringifies the error rather
    // than reading .message (String(err), `${err}`) prints "<name>: <msg>",
    // which would leak the provider despite the scrubbed message.
    this.name = "FreeVoiceError";
  }
}

// Env baseline for the perk budget. The live cap comes from the admin
// dashboard (Config → Quotas) via resolveQuotaCap; these are the
// fallback. Defined in lib/quota-config.ts to keep the import one-way,
// re-exported here because that's where callers look for them.
export { AI33_TTS_CAP_STARTER, AI33_TTS_CAP_PRO };

/** Synchronous env-only cap. Kept for callers that can't await; the
 *  admin-configured value is what generateAi33TTS actually enforces. */
export function ai33CapForPlan(plan: string | null | undefined, isAdmin = false): number {
  if (isAdmin) return AI33_TTS_CAP_PRO;
  const p = (plan ?? "").trim().toLowerCase();
  if (p === "founder") return 0;
  if (p === "pro") return AI33_TTS_CAP_PRO;
  // starter, demo, unknown → the entry-level cap.
  return AI33_TTS_CAP_STARTER;
}

// Voice ids are prefixed "ai33/" so they can't collide with ElevenLabs,
// google/ or qwen/ ids and generateTTS can route on the prefix alone. The
// value after "ai33/" is the real ai33 voice_id (which itself carries a
// provider prefix like elevenlabs_/minimax_). First tag is the gender so
// the picker's Female/Male tabs classify them. previewUrl points straight
// at ai33's own sample CDN — no synthesis, so previews don't burn quota.
function av(voiceId: string, label: string, tags: string[], previewUrl: string): KieModel {
  return {
    id: `ai33/${voiceId}`,
    name: label,
    type: "tts",
    tags,
    previewUrl,
  };
}

// Curated English subset of ai33's Voice Library (fetched live from
// GET /v3/voices?provider=…). Adjust freely — ids and preview URLs are
// the real values returned by the API.
//
// The voiceover step's Free tab renders the LIVE catalog now
// (listAi33Voices below); this list is the offline fallback for it, plus
// the catalog the one-click panel and the saved-voice-id → name lookup
// still read directly.
//
// Every id, gender tag and preview URL below was cross-checked against a
// live GET /v3/voices response. Two rules when adding more:
//   1. Only use preview URLs on storage.googleapis.com / the minimax CDN.
//      The API also hands back signed api.us.elevenlabs.io preview links
//      with an expiry baked into the payload — those go dead.
//   2. Keep the gender tag first. The Free tab's Male/Female subtabs
//      classify on tags[0]; anything not tagged Male/Female (River) shows
//      under both rather than being orphaned.
export const AI33_VOICES: KieModel[] = [
  // — Female —
  av("elevenlabs_hpp4J3VqNfWAUOO0d1Us", "Bella", ["Female", "Warm"], "https://storage.googleapis.com/eleven-public-prod/premade/voices/hpp4J3VqNfWAUOO0d1Us/dab0f5ba-3aa4-48a8-9fad-f138fea1126d.mp3"),
  av("elevenlabs_EXAVITQu4vr4xnSDxMaL", "Sarah", ["Female", "Confident"], "https://storage.googleapis.com/eleven-public-prod/premade/voices/EXAVITQu4vr4xnSDxMaL/01a3e33c-6e99-4ee7-8543-ff2216a32186.mp3"),
  av("elevenlabs_Xb7hH8MSUJpSbSDYk0k2", "Alice", ["Female", "Educator"], "https://storage.googleapis.com/eleven-public-prod/premade/voices/Xb7hH8MSUJpSbSDYk0k2/d10f7534-11f6-41fe-a012-2de1e482d336.mp3"),
  av("elevenlabs_XrExE9yKIg1WjnnlVkGX", "Matilda", ["Female", "Professional"], "https://storage.googleapis.com/eleven-public-prod/premade/voices/XrExE9yKIg1WjnnlVkGX/b930e18d-6b4d-466e-bab2-0ae97c6d8535.mp3"),
  av("elevenlabs_cgSgspJ2msm6clMCkdW9", "Jessica", ["Female", "Bright"], "https://storage.googleapis.com/eleven-public-prod/premade/voices/cgSgspJ2msm6clMCkdW9/56a97bf8-b69b-448f-846c-c3a11683d45a.mp3"),
  av("elevenlabs_pFZP5JQG7iQjIQuC4Bku", "Lily", ["Female", "Velvety"], "https://storage.googleapis.com/eleven-public-prod/premade/voices/pFZP5JQG7iQjIQuC4Bku/89b68b35-b3dd-4348-a84a-a3c13a3c2b30.mp3"),
  av("elevenlabs_RG7Vdpd6OigfTs8d4MVp", "Jamie", ["Female", "Narration"], "https://storage.googleapis.com/eleven-public-prod/database/workspace/1f9f6dc667d94e678e9c15b0dfbeca64/voices/RG7Vdpd6OigfTs8d4MVp/d11937f6-87c7-4205-b78b-28b529a3bb8c.mp3"),
  av("elevenlabs_QByd5J8pzbnMMEP2G7eR", "Gwen", ["Female", "Calm"], "https://storage.googleapis.com/eleven-public-prod/database/workspace/68f42f4cd7964f19892b652db8e12032/voices/QByd5J8pzbnMMEP2G7eR/a8fc0809-0f41-420a-a11a-fcc54f949245.mp3"),
  av("minimax_226893671006276", "Graceful Lady", ["Female", "Smooth"], "https://cdn.hailuoai.video/moss/prod/2025-01-15-19/moss-audio/voice_sample_audio/sample/1736941299124886240-/hailuo-audio-6d69767af53f485e91ac5c8fdd37644a.mp3"),
  av("minimax_209533299589184", "Calm Woman", ["Female", "Calm"], "https://cdn.hailuoai.video/moss/prod/2025-01-15-19/moss-audio/voice_sample_audio/sample/1736941303739967654-/hailuo-audio-3b6d05e3b5d82c9f9efee32506744504.mp3"),
  av("minimax_209533299589211", "Confident Woman", ["Female", "Confident"], "https://cdn.hailuoai.video/moss/prod/2025-01-15-19/moss-audio/voice_sample_audio/sample/1736941310656020634-/hailuo-audio-45285aa6111ab0951c13dd3ece8547e7.mp3"),
  av("minimax_236835177529412", "Captivating Female", ["Female", "Engaging"], "https://cdn.hailuoai.video/moss/prod/2025-02-12-21/moss-audio/voice_sample_audio/sample/1739367237379869109-/hailuo-audio-68dd4cbfe9fedc25d84930a814a87d67.mp3"),
  // — Male —
  av("elevenlabs_CwhRBWXzGAHq8TQ4Fs17", "Roger", ["Male", "Casual"], "https://storage.googleapis.com/eleven-public-prod/premade/voices/CwhRBWXzGAHq8TQ4Fs17/58ee3ff5-f6f2-4628-93b8-e38eb31806b0.mp3"),
  av("elevenlabs_JBFqnCBsd6RMkjVDRZzb", "George", ["Male", "Storyteller"], "https://storage.googleapis.com/eleven-public-prod/premade/voices/JBFqnCBsd6RMkjVDRZzb/e6206d1a-0721-4787-aafb-06a6e705cac5.mp3"),
  av("elevenlabs_N2lVS1w4EtoT3dr4eOWO", "Callum", ["Male", "Husky"], "https://storage.googleapis.com/eleven-public-prod/premade/voices/N2lVS1w4EtoT3dr4eOWO/ac833bd8-ffda-4938-9ebc-b0f99ca25481.mp3"),
  av("elevenlabs_TX3LPaxmHKxFdv7VOQHJ", "Liam", ["Male", "Energetic"], "https://storage.googleapis.com/eleven-public-prod/premade/voices/TX3LPaxmHKxFdv7VOQHJ/63148076-6363-42db-aea8-31424308b92c.mp3"),
  av("elevenlabs_bIHbv24MWmeRgasZH58o", "Will", ["Male", "Relaxed"], "https://storage.googleapis.com/eleven-public-prod/premade/voices/bIHbv24MWmeRgasZH58o/8caf8f3d-ad29-4980-af41-53f20c72d7a4.mp3"),
  av("elevenlabs_cjVigY5qzO86Huf0OWal", "Eric", ["Male", "Trustworthy"], "https://storage.googleapis.com/eleven-public-prod/premade/voices/cjVigY5qzO86Huf0OWal/d098fda0-6456-4030-b3d8-63aa048c9070.mp3"),
  av("elevenlabs_iP95p4xoKVk53GoZ742B", "Chris", ["Male", "Down-to-Earth"], "https://storage.googleapis.com/eleven-public-prod/premade/voices/iP95p4xoKVk53GoZ742B/3f4bde72-cc48-40dd-829f-57fbf906f4d7.mp3"),
  av("elevenlabs_pNInz6obpgDQGcFmaJgB", "Adam", ["Male", "Firm"], "https://storage.googleapis.com/eleven-public-prod/premade/voices/pNInz6obpgDQGcFmaJgB/d6905d7a-dd26-4187-bfff-1bd3a5ea7cac.mp3"),
  av("elevenlabs_pqHfZKP75CvOlQylNhV4", "Bill", ["Male", "Mature"], "https://storage.googleapis.com/eleven-public-prod/premade/voices/pqHfZKP75CvOlQylNhV4/d782b3ff-84ba-4029-848c-acf01285524d.mp3"),
  av("minimax_209533299589198", "Captivating Storyteller", ["Male", "Narration"], "https://cdn.hailuoai.video/moss/prod/2025-01-15-19/moss-audio/voice_sample_audio/sample/1736941309798396434-/hailuo-audio-2522ec7dd4a9aa794d27d9ee907f1add.mp3"),
  av("minimax_226893671006272", "Trustworthy Man", ["Male", "Trustworthy"], "https://cdn.hailuoai.video/moss/prod/2025-01-15-19/moss-audio/voice_sample_audio/sample/1736941329063790325-/hailuo-audio-e2ea21ce9a5bfa6ec085f1555be39a49.mp3"),
  av("minimax_209533299589222", "Deep-toned Man", ["Male", "Deep"], "https://cdn.hailuoai.video/moss/staging/2024-11-25-20/moss-audio/voice_sample_audio/1732537382045424511-official_sample_audio/20241114-frontend-test-EaMWHefmpjmIYbLRYJclDWTz.mp3"),
  // — Neutral (shows under both subtabs) —
  av("elevenlabs_SAz9YHcvj6GT2YYXdXww", "River", ["Neutral", "Informative"], "https://storage.googleapis.com/eleven-public-prod/premade/voices/SAz9YHcvj6GT2YYXdXww/e6c95f0b-2227-491a-b3d7-2249240decb7.mp3"),
];

// Free-tab subtab split. Anything without a Male/Female tag (River, tagged
// Neutral) appears under both rather than being unreachable.
export function ai33VoicesByGender(gender: "Female" | "Male"): KieModel[] {
  const other = gender === "Female" ? "Male" : "Female";
  return AI33_VOICES.filter((v) => v.tags?.includes(gender) || !v.tags?.includes(other));
}

// ── Live catalog ────────────────────────────────────────────────────
// The Free tab used to render the 25 static entries above and nothing
// else, which was a rounding error against what ai33 actually exposes.
// Verified live 2026-07-28, English-only totals per provider:
// elevenlabs 9,319 · minimax 100 · fishaudio 50 · edge 47. So the tab
// now pages through GET /v3/voices and AI33_VOICES is demoted to the
// offline fallback (still the source of truth for the one-click panel
// and for resolving a saved voice id to a name).
//
// GET /v3/voices contract, all confirmed against live responses:
//   • `provider` is REQUIRED — omitting it 400s with
//     unsupported_voice_provider and lists the accepted values
//     (elevenlabs, minimax, clone, edge, kokoro, vbee, fishaudio).
//   • `language=en` matches en / en-US / en-GB / … across providers,
//     including minimax's spelled-out "English". `gender` is
//     case-insensitive. `search` is free text over name/description.
//   • `page` + `page_size` paginate; the envelope is
//     { success, format_version, data: [...], pagination:
//       { page, page_size, total, has_more } }.
//   • QUIRK: elevenlabs prepends its ~21 premade voices to EVERY page,
//     so data.length exceeds page_size and those 21 repeat page over
//     page. Dedupe by voice_id across pages, and take has_more from
//     `pagination` rather than inferring it from data.length.
//
// Providers are limited to the four where a live POST
// /v3/text-to-speech actually returned audio. kokoro is out: it lists
// 28 English voices but synthesis rejects with provider_unavailable
// ("Kokoro is undermantain"). vbee is out: Vietnamese-first, its only
// English entries are beta clones. clone is out: the account has none.
// `id` is ai33's provider key (also the prefix on every one of its voice
// ids); `label` is what the Free tab's provider subtabs show.
export const AI33_FREE_PROVIDERS = [
  { id: "elevenlabs", label: "ElevenLabs" },
  { id: "minimax", label: "MiniMax" },
  { id: "fishaudio", label: "Fish Audio" },
  { id: "edge", label: "Edge" },
] as const;

export type Ai33Provider = (typeof AI33_FREE_PROVIDERS)[number]["id"];

export function isAi33Provider(value: string): value is Ai33Provider {
  return AI33_FREE_PROVIDERS.some((p) => p.id === value);
}

// One page = one page from each provider, concatenated (~135-145 cards on
// page 1, ~55 after — the small providers run dry first). With a single
// provider selected it's just that provider's page.
const PROVIDER_PAGE_SIZE = 40;

// Hosts that return SIGNED preview links with an expiry baked into the
// payload — the mp3 goes dead and the card is left with a dud play
// button. Everything else ai33 hands back is a plain static CDN object
// (storage.googleapis.com, cdn.hailuoai.video, filecdn.minimax.chat,
// platform.r2.fish.audio, cdn.ai33.pro, vbee's S3 bucket), so this is a
// denylist of the known-expiring hosts rather than an allowlist that
// would silently drop a new CDN. Costs ~15 of elevenlabs' 47 rows per
// page; against 9,319 available that's not worth proxying.
const EXPIRING_PREVIEW_HOSTS = new Set(["api.us.elevenlabs.io", "api.elevenlabs.io"]);

interface Ai33VoiceRow {
  voice_id?: string;
  name?: string | null;
  description?: string | null;
  language?: string | null;
  locale?: string | null;
  gender?: string | null;
  accent?: string | null;
  category?: string | null;
  use_cases?: string[] | null;
  descriptives?: string[] | null;
  tags?: string[] | null;
  preview_url?: string | null;
}

interface Ai33VoicesResponse {
  success?: boolean;
  message?: string | null;
  data?: Ai33VoiceRow[];
  pagination?: { page?: number; page_size?: number; total?: number; has_more?: boolean };
}

export interface Ai33VoicePage {
  voices: KieModel[];
  /** Another page exists for at least one provider. */
  hasMore: boolean;
  /** false = these are the static AI33_VOICES, not the live catalog. */
  live: boolean;
}

// Safety net for the API's `language` filter, which is applied
// per-provider upstream and can't be assumed uniform. Matches "en",
// "en-US", and minimax/kokoro's spelled-out "English"/"American
// English"; rejects vbee's "Vietnamese" + "northern" locale.
function isEnglish(row: Ai33VoiceRow): boolean {
  const fields = `${row.locale ?? ""} ${row.language ?? ""}`.toLowerCase();
  if (fields.includes("english")) return true;
  return fields.split(/\s+/).some((t) => t === "en" || t.startsWith("en-"));
}

function usablePreview(url: string | null | undefined): string | null {
  if (!url || !url.startsWith("http")) return null;
  try {
    if (EXPIRING_PREVIEW_HOSTS.has(new URL(url).hostname)) return null;
  } catch {
    return null;
  }
  return url;
}

function titleCase(s: string): string {
  return s.replace(/[_-]/g, " ").replace(/^./, (c) => c.toUpperCase());
}

// Tokens that say nothing a card doesn't already show: the gender pill
// covers gender, and age/language/category noise isn't worth a pill.
const NOISE_TAGS = new Set([
  "male", "female", "neutral", "unknown",
  "young", "old", "adult", "child", "teen", "senior", "middle_aged", "middle-aged",
  "premade", "standard", "open-source", "high_quality",
]);

// Fish Audio puts everything descriptive in `tags` and leaves
// descriptives/use_cases/accent/locale empty — without this every one of
// its cards would show a lone gender pill. Language codes ("en",
// "en-US") are dropped along with the noise tokens above.
function descriptorFromTags(tags: string[] | null | undefined): string | null {
  for (const raw of tags ?? []) {
    const t = raw.trim();
    if (!t) continue;
    const lower = t.toLowerCase();
    if (NOISE_TAGS.has(lower)) continue;
    if (/^[a-z]{2,3}(-[a-z0-9]+)?$/i.test(t)) continue; // en, en-US, zh-Hant
    return titleCase(t);
  }
  return null;
}

// ElevenLabs library names carry their own descriptor after a dash
// ("Bella - Professional, Bright, Warm"). The card truncates the name
// to one line, so the descriptor is split off and shown as a tag pill
// instead of being cut off mid-word.
function splitName(raw: string): { name: string; descriptor: string | null } {
  const parts = raw.split(/\s+-\s+/);
  if (parts.length < 2) return { name: raw.trim(), descriptor: null };
  const name = parts[0].trim();
  const descriptor = parts.slice(1).join(" - ").trim();
  return { name: name || raw.trim(), descriptor: descriptor || null };
}

// Edge voices carry Microsoft's raw shortname as their name
// ("en-AU-WilliamMultilingualNeural"), which reads as an id on a card.
// Pull the human part out: → "William". The locale still shows as the
// voice's tag, so nothing is lost.
//
// The Multilingual/Expressive variant is kept as a suffix rather than
// dropped: en-US ships both AndrewNeural and AndrewMultilingualNeural
// (same for Ava, Brian, Emma, Neerja), and without it those render as
// two identical "Andrew" cards with no way to tell them apart.
function prettifyEdgeName(raw: string): string {
  const m = raw.match(/^[a-z]{2,3}(?:-[A-Za-z]+)*?-([A-Za-z]+?)(Multilingual|Expressive)?Neural$/);
  if (!m) return raw;
  return m[2] ? `${m[1]} (${m[2].toLowerCase()})` : m[1];
}

// requirePreview=false is for resolving a single already-selected voice
// to its name, where a dead preview link is no reason to hide it.
function rowToModel(row: Ai33VoiceRow, requirePreview = true): KieModel | null {
  const voiceId = (row.voice_id ?? "").trim();
  if (!voiceId) return null;
  const previewUrl = usablePreview(row.preview_url);
  if (!previewUrl && requirePreview) return null;

  const rawName = (row.name ?? voiceId).trim();
  const { name, descriptor } = splitName(
    voiceId.startsWith("edge_") ? prettifyEdgeName(rawName) : rawName,
  );
  const g = (row.gender ?? "").toLowerCase();
  // Gender tag stays first — the Free tab's Male/Female subtabs and the
  // selected-voice banner both read tags[0].
  const genderTag = g === "female" ? "Female" : g === "male" ? "Male" : "Neutral";

  // One descriptor pill, so a card is never more than two tags wide.
  // Falls back through the structured fields when the name carries no
  // descriptor of its own (minimax, edge, fishaudio).
  const fallbackDescriptor =
    [...(row.descriptives ?? []), ...(row.use_cases ?? []), row.accent]
      .filter((s): s is string => !!s && s.trim().length > 0)
      .map((s) => titleCase(s.trim()))[0]
    ?? descriptorFromTags(row.tags)
    // Locale last and NOT title-cased — "en-AU" is the canonical form,
    // "En-AU" just looks like a typo.
    ?? row.locale?.trim()
    ?? null;
  const detail = descriptor ?? fallbackDescriptor;
  const tags = [genderTag, ...(detail ? [detail.length > 44 ? `${detail.slice(0, 43)}…` : detail] : [])];

  return {
    id: `ai33/${voiceId}`,
    name,
    type: "tts",
    tags,
    ...(previewUrl ? { previewUrl } : {}),
  };
}

async function fetchProviderPage(
  provider: string,
  page: number,
  opts: { gender?: "Female" | "Male"; search?: string },
  token: string,
): Promise<{ rows: Ai33VoiceRow[]; hasMore: boolean }> {
  const params = new URLSearchParams({
    provider,
    language: "en",
    page: String(page),
    page_size: String(PROVIDER_PAGE_SIZE),
  });
  if (opts.gender) params.set("gender", opts.gender.toLowerCase());
  const search = opts.search?.trim();
  if (search) params.set("search", search);

  try {
    const res = await fetch(`${AI33_BASE}/v3/voices?${params.toString()}`, {
      headers: { "xi-api-key": token },
      // Catalogs change rarely; don't hit ai33 on every picker render or
      // every keystroke of a search that resolves to the same query.
      next: { revalidate: 900 },
    });
    if (!res.ok) {
      console.warn(`[ai33] /v3/voices ${provider} failed (${res.status})`);
      return { rows: [], hasMore: false };
    }
    const body = (await res.json().catch(() => null)) as Ai33VoicesResponse | null;
    if (!body || body.success === false || !Array.isArray(body.data)) {
      console.warn(`[ai33] /v3/voices ${provider} returned no data: ${body?.message ?? "unknown"}`);
      return { rows: [], hasMore: false };
    }
    return { rows: body.data.filter(isEnglish), hasMore: body.pagination?.has_more === true };
  } catch (e) {
    console.warn(`[ai33] /v3/voices ${provider} fetch failed:`, e instanceof Error ? e.message : e);
    return { rows: [], hasMore: false };
  }
}

/** One page of the live ai33 English catalog — from a single provider
 *  when `provider` is set, otherwise every provider we can actually
 *  synthesize with, concatenated in AI33_FREE_PROVIDERS order. Degrades
 *  to the static AI33_VOICES (flagged `live: false`) when the token is
 *  missing or every fetch fails, so the Free tab never renders empty. */
export async function listAi33Voices(opts: {
  provider?: Ai33Provider;
  gender?: "Female" | "Male";
  search?: string;
  page?: number;
} = {}): Promise<Ai33VoicePage> {
  const token = (process.env.AI33_API_TOKEN ?? "").trim();
  const staticFallback = (): Ai33VoicePage => {
    const base = opts.gender ? ai33VoicesByGender(opts.gender) : AI33_VOICES;
    // The static catalog only covers elevenlabs and minimax, so a
    // provider-scoped fallback can legitimately come back empty.
    return {
      voices: opts.provider ? base.filter((v) => v.id.startsWith(`ai33/${opts.provider}_`)) : base,
      hasMore: false,
      live: false,
    };
  };
  if (!token) return staticFallback();

  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const providers = opts.provider ? [opts.provider] : AI33_FREE_PROVIDERS.map((p) => p.id);
  const pages = await Promise.all(
    providers.map((p) => fetchProviderPage(p, page, opts, token)),
  );

  // Provider order is the display order. Dedupe across providers AND
  // across pages-within-a-provider (elevenlabs repeats its premade
  // block on every page).
  const seen = new Set<string>();
  const voices: KieModel[] = [];
  for (const { rows } of pages) {
    for (const row of rows) {
      const model = rowToModel(row);
      if (!model || seen.has(model.id)) continue;
      seen.add(model.id);
      voices.push(model);
    }
  }

  // Nothing at all on the first page means ai33 is unreachable rather
  // than "this search has no hits" — fall back so the tab stays usable.
  // A later page legitimately coming back empty just ends the list.
  if (!voices.length && page === 1 && !opts.search) return staticFallback();

  return { voices, hasMore: pages.some((p) => p.hasMore), live: true };
}

/** Resolve ONE ai33 voice id to its catalog entry, for naming a voice a
 *  project already has saved. Needed because a saved voice is usually
 *  nowhere in the page the picker happens to have loaded (the catalog is
 *  thousands deep), and AI33_VOICES only covers the 25 static ones —
 *  without this the selected-voice banner reads "Unknown voice".
 *
 *  ai33 has no by-id endpoint (GET /v3/voices/{id} 404s and `voice_id=`
 *  is ignored), but `search=<voice_id>` matches the id exactly — verified
 *  for elevenlabs, minimax, fishaudio and edge ids. */
export async function resolveAi33Voice(voiceId: string): Promise<KieModel | null> {
  if (!isAi33Voice(voiceId)) return null;
  const fromStatic = AI33_VOICES.find((v) => v.id === voiceId);
  if (fromStatic) return fromStatic;

  const token = (process.env.AI33_API_TOKEN ?? "").trim();
  if (!token) return null;

  const rawId = voiceId.replace(/^ai33\//, "");
  // ai33 ids are "<provider>_<upstream id>" — the provider is required
  // on the query, so read it off the prefix.
  const provider = rawId.split("_")[0];
  if (!provider) return null;

  const params = new URLSearchParams({ provider, search: rawId, page_size: "5" });
  try {
    const res = await fetch(`${AI33_BASE}/v3/voices?${params.toString()}`, {
      headers: { "xi-api-key": token },
      next: { revalidate: 900 },
    });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as Ai33VoicesResponse | null;
    const hit = (body?.data ?? []).find((r) => r.voice_id === rawId);
    return hit ? rowToModel(hit, false) : null;
  } catch (e) {
    console.warn("[ai33] voice resolve failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

export function isAi33Voice(voiceId: string): boolean {
  return voiceId.startsWith("ai33/");
}

// Voice cloning, per ai33's own API docs:
//   POST   /v3/text-to-speech/voice-clone       voice_name + audio_file
//   DELETE /v3/text-to-speech/voice-clone/{id}
// The returned id is used as "clone_<voice_id>" for synthesis, which makes
// it an ordinary "ai33/clone_…" voice here — no dispatch change needed.
// The clone lands on HECLUS's ai33 account, so ownership is ours to track
// (see lib/cloned-voices.ts).
export const AI33_CLONE_MAX_BYTES = 10 * 1024 * 1024;
export const AI33_CLONE_MIN_SECONDS = 3;
export const AI33_CLONE_MAX_SECONDS = 30;

/** Returns the ai33-side voice id, already in "clone_…" form. */
export async function cloneAi33Voice(opts: {
  name: string;
  audio: Blob;
  filename: string;
  removeBackground?: boolean;
}): Promise<string> {
  const token = (process.env.AI33_API_TOKEN ?? "").trim();
  if (!token) throw new Ai33TTSError("Voice cloning isn't available right now.", 503);

  const form = new FormData();
  form.append("voice_name", opts.name);
  form.append("audio_file", opts.audio, opts.filename);
  if (opts.removeBackground) form.append("remove_background", "true");

  const res = await fetch(`${AI33_BASE}/v3/text-to-speech/voice-clone`, {
    method: "POST",
    headers: { "xi-api-key": token },
    body: form,
  });
  const body = (await res.json().catch(() => null)) as
    | { success?: boolean; message?: string; data?: { voice_id?: string } }
    | null;
  if (!res.ok || body?.success === false || !body?.data?.voice_id) {
    throw new Ai33TTSError(body?.message ?? `Voice cloning failed (${res.status}).`, res.status);
  }
  const rawId = body.data.voice_id;
  return rawId.startsWith("clone_") ? rawId : `clone_${rawId}`;
}

export async function deleteAi33Clone(providerVoiceId: string): Promise<void> {
  const token = (process.env.AI33_API_TOKEN ?? "").trim();
  if (!token) throw new Ai33TTSError("Voice cloning isn't available right now.", 503);

  // The path takes the bare upstream id, not the "clone_" synthesis form.
  const upstreamId = providerVoiceId.replace(/^clone_/, "");
  const res = await fetch(`${AI33_BASE}/v3/text-to-speech/voice-clone/${encodeURIComponent(upstreamId)}`, {
    method: "DELETE",
    headers: { "xi-api-key": token },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Ai33TTSError(body?.message ?? `Couldn't delete that voice (${res.status}).`, res.status);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const AI33_BASE = (process.env.AI33_API_BASE ?? "https://api.ai33.pro").replace(/\/+$/, "");

// ai33 rate limits are undocumented; gate concurrent submits through a
// small module-level queue like the Qwen path, with retry as the
// cross-invocation backstop.
const MAX_INFLIGHT = 2;
const START_GAP_MS = 400;
let inflight = 0;
const waiters: (() => void)[] = [];

async function acquireSlot(): Promise<void> {
  if (inflight < MAX_INFLIGHT) { inflight++; return; }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inflight++;
}
function releaseSlot(): void {
  inflight--;
  waiters.shift()?.();
}

// Verified live: POST returns { success, task_id }; GET /v3/task/{id}
// returns { success, data: { status, metadata, progress, ... } }. A
// throttled poll returns { success:false, message: "Task polling
// temporarily busy" } — transient, keep waiting.
//
// WHERE THE AUDIO URL LIVES: this has moved on us. It used to arrive at
// metadata.v3.audio_url; as of 2026-07-27 live responses put it at
// metadata.audio_url for BOTH shapes — elevenlabs (type "tts") and
// minimax (type "minimax_tts") — with metadata.v3 cut down to
// { provider, raw_voice_id }. Reading one hard-coded path meant a silent
// upstream move took down every free voice at once with "finished but
// returned no audio URL". audioUrlFrom now checks the known paths and
// then falls back to a scan, so the next move degrades to nothing.
interface Ai33TaskData {
  id?: string;
  status?: string;
  progress?: number;
  metadata?: {
    audio_url?: string;
    v3?: { audio_url?: string };
    data?: { audio_url?: string };
  };
  audio_url?: string;
  error?: string | null;
  message?: string | null;
}
interface Ai33TaskResponse {
  success?: boolean;
  message?: string | null;
  task_id?: string;
  id?: string;
  data?: Ai33TaskData;
}

// Depth-bounded hunt for any *audio*_*url* key holding an http string, so
// a future reshuffle of the payload doesn't need a code change to work.
function findAudioUrl(value: unknown, depth = 0): string | null {
  if (depth > 5 || value === null || typeof value !== "object") return null;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/audio/i.test(k) && /url/i.test(k) && typeof v === "string" && v.startsWith("http")) {
      return v;
    }
  }
  // Keys first at each level, then recurse — a shallower match wins over a
  // deeper one.
  for (const v of Object.values(value as Record<string, unknown>)) {
    const nested = findAudioUrl(v, depth + 1);
    if (nested) return nested;
  }
  return null;
}

function audioUrlFrom(data: Ai33TaskData): string | null {
  const known = [
    data.metadata?.audio_url,
    data.metadata?.v3?.audio_url,
    data.metadata?.data?.audio_url,
    data.audio_url,
  ];
  for (const url of known) {
    if (typeof url === "string" && url.startsWith("http")) return url;
  }
  return findAudioUrl(data);
}

const DONE = ["success", "succeeded", "completed", "complete", "done", "finished", "finish"];
const FAIL = ["failed", "fail", "error", "canceled", "cancelled"];

function classify(data: Ai33TaskData): "done" | "failed" | "pending" {
  const s = (data.status ?? "").toString().toLowerCase();
  if (FAIL.includes(s)) return "failed";
  if (DONE.includes(s)) return "done";
  return "pending";
}

// Submit one synthesis and return its task_id, riding out transient
// throttling / blips.
async function submitTask(text: string, voiceId: string, token: string): Promise<string> {
  const MAX_RETRIES = 5;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      const form = new FormData();
      form.append("text", text);
      form.append("voice_id", voiceId);
      form.append("speed", "1");
      form.append("with_transcript", "false");
      res = await fetch(`${AI33_BASE}/v3/text-to-speech`, {
        method: "POST",
        headers: { "xi-api-key": token },
        body: form,
      });
    } catch (err) {
      if (attempt < MAX_RETRIES) { await sleep(Math.min(10_000, 2000 * 2 ** attempt)); continue; }
      throw new Ai33TTSError(`Network error reaching the voice service: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new Ai33TTSError("Free voices aren't available right now.", res.status);
    }
    if (res.status === 402) {
      throw new Ai33TTSError("Free voices are temporarily unavailable.", 402);
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt < MAX_RETRIES) {
        const retryAfter = Number(res.headers.get("Retry-After"));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(15_000, retryAfter * 1000)
          : Math.min(10_000, 2000 * 2 ** attempt);
        await sleep(waitMs);
        continue;
      }
      throw new Ai33TTSError(`Free voices failed (${res.status}) after retries. Try again.`, res.status);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Ai33TTSError(`Free voices failed (${res.status}): ${body.replace(/\s+/g, " ").trim().slice(0, 300)}`, res.status);
    }

    const data = (await res.json().catch(() => null)) as Ai33TaskResponse | null;
    const taskId = data?.task_id ?? data?.id;
    if (!taskId) throw new Ai33TTSError("The voice service returned no task.");
    return taskId;
  }
}

// Poll GET /v3/task/{id} until the audio is ready, then download it.
async function pollAndDownload(taskId: string, token: string): Promise<ArrayBuffer> {
  const deadline = Date.now() + 120_000;
  const pollUrl = `${AI33_BASE}/v3/task/${encodeURIComponent(taskId)}`;
  for (;;) {
    if (Date.now() > deadline) throw new Ai33TTSError("Voice generation timed out. Try again.", 504);
    await sleep(2500);
    const poll = await fetch(pollUrl, { headers: { "xi-api-key": token } }).catch(() => null);
    if (!poll || poll.status === 429 || poll.status >= 500) continue; // transient — keep waiting
    if (!poll.ok) throw new Ai33TTSError(`Voice generation check failed (${poll.status}).`, poll.status);
    const body = (await poll.json().catch(() => null)) as Ai33TaskResponse | null;
    if (!body) continue;
    // Throttled poll ("Task polling temporarily busy") comes back as
    // success:false with no data — wait and retry, don't treat as failure.
    if (body.success === false || !body.data) continue;
    const data = body.data;
    const verdict = classify(data);
    if (verdict === "pending") continue;
    if (verdict === "failed") {
      throw new Ai33TTSError(`Voice generation failed: ${(data.error ?? data.message ?? "unknown error").toString().slice(0, 300)}`);
    }
    const url = audioUrlFrom(data);
    if (!url) throw new Ai33TTSError("Voice generation finished but returned no audio.");
    const audioRes = await fetch(url);
    if (!audioRes.ok) throw new Ai33TTSError(`Failed to download the generated audio (${audioRes.status}).`);
    return audioRes.arrayBuffer();
  }
}

export async function generateAi33TTS(
  text: string,
  voiceId: string,
  userId?: string,
): Promise<{ audio: ArrayBuffer; charsConsumed: number }> {
  if (!userId) throw new Ai33TTSError("Sign in to use free voiceover.", 401);
  const token = (process.env.AI33_API_TOKEN ?? "").trim();
  if (!token) {
    throw new Ai33TTSError("Free voices aren't available right now.", 503);
  }

  // Per-user monthly perk budget, allocated per plan by the admin. We pay
  // for these characters, so enforce the cap up front.
  const { data: userData } = await supabase.auth.admin.getUserById(userId);
  const meta = (userData?.user?.app_metadata ?? {}) as { plan?: string };
  // isAdminUser, not the raw app_metadata.is_admin flag — legacy
  // ADMIN_EMAILS admins carry no flag and no plan, so the flag alone
  // resolved them to 0 and blocked the perk they're supposed to get.
  const cap = await resolveQuotaCap("ai33_tts_chars", meta.plan, isAdminUser(userData?.user));
  if (cap <= 0) {
    // 0 = the plan opts out. Any plan can be set to 0, so don't hardcode
    // "Founder" in the message.
    const plan = (meta.plan ?? "").trim();
    throw new Ai33TTSError(
      `Free voices aren't included in ${plan ? `the ${plan} plan` : "your plan"} — pick a paid voice, or upgrade your plan.`,
      403,
    );
  }
  const used = await getFreeUsageThisMonth(userId, "ai33_tts_chars");
  if (used + text.length > cap) {
    throw new Ai33TTSError(
      `This voiceover needs ${text.length.toLocaleString()} characters but you have ${Math.max(0, cap - used).toLocaleString()} left on this month's free quota. It resets next month — or pick a paid voice.`,
      429,
    );
  }

  const realVoiceId = voiceId.replace(/^ai33\//, "");

  await acquireSlot();
  let taskId: string;
  try {
    taskId = await submitTask(text, realVoiceId, token);
    await sleep(START_GAP_MS); // brief spacing between queued submits
  } finally {
    releaseSlot();
  }

  const audio = await pollAndDownload(taskId, token);
  return { audio, charsConsumed: text.length };
}
