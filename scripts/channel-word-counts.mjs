import { readFileSync } from "node:fs";

function loadEnv(file) {
  return Object.fromEntries(
    readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => {
        const idx = l.indexOf("=");
        const k = l.slice(0, idx);
        let v = l.slice(idx + 1);
        if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
        return [k, v];
      })
  );
}

// Merge but skip empty overrides from .env.local (sensitive vars pulled
// from Vercel come down as "" and would clobber the working .env values).
const base = loadEnv(".env");
const local = loadEnv(".env.local");
const env = { ...base };
for (const [k, v] of Object.entries(local)) {
  if (v && v.length > 0) env[k] = v;
}
const YT = env.YOUTUBE_API_KEY;
const SUPADATA = env.SUPADATA_API_KEY;
if (!YT || !SUPADATA) throw new Error("Missing YOUTUBE_API_KEY or SUPADATA_API_KEY");

const HANDLE = process.argv[2] ?? "SleeplessHistorian";

async function ytGet(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`YT ${res.status}: ${await res.text()}`);
  return res.json();
}

// 1. Resolve handle → channel ID
const chanRes = await ytGet(`https://www.googleapis.com/youtube/v3/channels?part=id,snippet&forHandle=${HANDLE}&key=${YT}`);
const channel = chanRes.items?.[0];
if (!channel) throw new Error(`Channel not found: @${HANDLE}`);
console.log(`Channel: ${channel.snippet.title} (${channel.id})\n`);

// 2. Top 10 by view count
const searchRes = await ytGet(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${channel.id}&type=video&order=viewCount&maxResults=10&key=${YT}`);
const videoIds = (searchRes.items ?? []).map((i) => i.id.videoId);

// 3. Pull metadata (title + view count + duration)
const metaRes = await ytGet(`https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics,contentDetails&id=${videoIds.join(",")}&key=${YT}`);
const videos = metaRes.items ?? [];

function isoToReadable(iso) {
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return iso;
  const [, h, mm, s] = m;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (mm) parts.push(`${mm}m`);
  if (s) parts.push(`${s}s`);
  return parts.join("") || "0s";
}

// 4. Fetch transcripts via Supadata, count words
const results = [];
for (const v of videos) {
  try {
    const tr = await fetch(`https://api.supadata.ai/v1/youtube/transcript?videoId=${v.id}&text=true`, {
      headers: { "x-api-key": SUPADATA },
    });
    if (!tr.ok) {
      results.push({ id: v.id, title: v.snippet.title, words: null, error: `Supadata ${tr.status}`, duration: v.contentDetails.duration, views: parseInt(v.statistics.viewCount ?? "0", 10) });
      continue;
    }
    const data = await tr.json();
    const content = typeof data.content === "string" ? data.content : (data.transcript ?? "");
    const words = content.trim().split(/\s+/).filter(Boolean).length;
    results.push({ id: v.id, title: v.snippet.title, words, duration: v.contentDetails.duration, views: parseInt(v.statistics.viewCount ?? "0", 10) });
  } catch (e) {
    results.push({ id: v.id, title: v.snippet.title, words: null, error: e.message, duration: v.contentDetails.duration, views: parseInt(v.statistics.viewCount ?? "0", 10) });
  }
}

// 5. Print table
console.log("Rank | Words   | Duration | Views     | Title");
console.log("-----+---------+----------+-----------+------");
results.forEach((r, i) => {
  const rank = String(i + 1).padStart(2, " ");
  const words = r.words === null ? "ERR".padStart(7) : String(r.words).padStart(7);
  const dur = isoToReadable(r.duration).padEnd(8);
  const views = (r.views / 1000).toFixed(0) + "k";
  console.log(`  ${rank} | ${words} | ${dur} | ${views.padStart(9)} | ${r.title.slice(0, 80)}`);
  if (r.error) console.log(`       error: ${r.error}`);
});

const valid = results.filter((r) => r.words !== null);
if (valid.length > 0) {
  const avg = Math.round(valid.reduce((s, r) => s + r.words, 0) / valid.length);
  const min = Math.min(...valid.map((r) => r.words));
  const max = Math.max(...valid.map((r) => r.words));
  console.log(`\nAvg: ${avg} words   Min: ${min}   Max: ${max}   Sampled: ${valid.length}/10`);
}
