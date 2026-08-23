// Ask PoYo which sizes each image model accepts.
//
// PoYo validates `size` per model and rejects anything outside that model's own
// list, so a house default of 16:9 fails outright on models that only speak in
// pixel dimensions. The lists are not documented, but the validator names them:
// a submit carrying a deliberately impossible size comes back with
// "Invalid size ... Supported: ..." before any generation starts.
//
//   node scripts/probe-poyo-sizes.mjs                    # prints a table
//   node scripts/probe-poyo-sizes.mjs --json             # machine-readable
//   node scripts/probe-poyo-sizes.mjs --only gpt-image-2 # one or more ids
//
// Spends nothing as long as the model validates size. Prompt is validated
// first, so the prompt below is real; a model that does not validate size takes
// the garbage one and generates, which costs a real generation. The four known
// to do that are in NO_VALIDATION and skipped unless named with --only, and any
// new one is reported as ACCEPTED ANY rather than counted as a pass.
//
// Key: HECLUS_POYO_API_KEY in the environment, or --key <value>.

import fs from "node:fs";

const args = process.argv.slice(2);
const JSON_OUT = args.includes("--json");
const only = args.includes("--only")
  ? args[args.indexOf("--only") + 1]?.split(",").map((s) => s.trim()).filter(Boolean) ?? []
  : null;

// Probed 2026-08-23: these accepted a garbage size and generated anyway, so
// probing them costs credits and teaches nothing. grok-imagine-image-2.0 is
// here because it reads the ratio from `aspect_ratio` and ignores `size`
// entirely; "grok-imagine" is xAI's video endpoint and no longer in the picker.
const NO_VALIDATION = ["nano-banana", "nano-banana-pro", "grok-imagine", "grok-imagine-image-2.0"];
const key = args.includes("--key") ? args[args.indexOf("--key") + 1] : process.env.HECLUS_POYO_API_KEY;

if (!key) {
  console.error("No PoYo key. Set HECLUS_POYO_API_KEY or pass --key <value>.");
  process.exit(2);
}

const src = fs.readFileSync(new URL("../lib/poyo/imageModels.ts", import.meta.url), "utf8");
const models = [...src.matchAll(/m\("([^"]+)",\s*"([^"]+)",\s*([\d.]+),\s*(true|false)/g)]
  .map(([, id, , , verified]) => ({ id, verified: verified === "true" }))
  .filter((m) => (only ? only.includes(m.id) : !NO_VALIDATION.includes(m.id)));

const IMPOSSIBLE = "__probe__";

async function probe(id) {
  const res = await fetch("https://api.poyo.ai/api/generate/submit", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: id, input: { prompt: "a single grey square", size: IMPOSSIBLE } }),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* non-JSON body falls through to raw */ }
  const message = json?.error?.message ?? json?.message ?? text.slice(0, 200);

  if (json?.code === 200 && json?.data?.task_id) {
    return { verdict: "ACCEPTED ANY", sizes: null, detail: `took the bogus size, task ${json.data.task_id} (this one cost credits)` };
  }
  // Two phrasings, one per model family: "Supported: a, b" and "must be one
  // of: a, b". Both may prefix the list with "values".
  const list = /(?:supported|must be one of)\s*(?:values)?\s*:?\s*(.+)$/i.exec(message);
  if (list) {
    const sizes = list[1]
      .replace(/^values:?\s*/i, "")
      .replace(/,?\s*or custom.*$/i, "")
      .split(/,\s*/)
      .map((s) => s.trim().replace(/\.$/, ""))
      .filter(Boolean)
      // "WIDTHxHEIGHT" and "{width, height}" are the custom-size placeholder,
      // not a size; the flag below carries that instead. Every real token has a
      // digit in it, apart from "auto".
      .filter((s) => /\d/.test(s) || /^auto$/i.test(s));
    const custom = /widthxheight/i.test(message);
    return { verdict: "OK", sizes, custom, detail: "" };
  }
  return { verdict: "UNKNOWN", sizes: null, detail: `${res.status}: ${message}` };
}

const out = [];
for (const model of models) {
  let r;
  try { r = await probe(model.id); }
  catch (e) { r = { verdict: "UNKNOWN", sizes: null, detail: e instanceof Error ? e.message : String(e) }; }
  out.push({ ...model, ...r });
  if (!JSON_OUT) {
    const body = r.sizes ? r.sizes.join(", ") + (r.custom ? "  (+ WxH)" : "") : r.detail;
    console.log(`${r.verdict.padEnd(12)} ${model.id.padEnd(26)} ${body}`);
  }
  // PoYo publishes no rate limit for submit; pace it rather than find out.
  await new Promise((r) => setTimeout(r, 400));
}

if (JSON_OUT) console.log(JSON.stringify(out, null, 2));
else {
  const missing16 = out.filter((r) => r.sizes && !r.sizes.includes("16:9"));
  console.log(`\n${out.filter((r) => r.verdict === "OK").length}/${out.length} answered.`);
  if (missing16.length) {
    console.log(`\nNo 16:9 (the house default) on: ${missing16.map((r) => r.id).join(", ")}`);
  }
}
