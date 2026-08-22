// Check which PoYo model ids in lib/poyo/imageModels.ts are real.
//
// PoYo publishes credit costs against display names but not the identifier to
// send in the `model` field, so most of the catalog is inferred from the two
// ids that do appear in their docs. An inferred id that is wrong fails at
// submit, after the wallet has already reserved credits, which is why those
// models are withheld from the picker until this script clears them.
//
//   node scripts/verify-poyo-catalog.mjs           # probe, spends nothing
//   node scripts/verify-poyo-catalog.mjs --spend   # real 1-image submits
//
// Default mode sends a deliberately empty prompt. A live model rejects it for
// the prompt; an unknown model rejects it for the model, and the two error
// messages are distinguishable. That is an inference about PoYo's validation
// order, so anything it cannot classify is reported as UNKNOWN rather than
// guessed at, and --spend settles those with a real generation.
//
// Key: HECLUS_POYO_API_KEY in the environment, or --key <value>.

import fs from "node:fs";

const args = process.argv.slice(2);
const SPEND = args.includes("--spend");
const key = args.includes("--key")
  ? args[args.indexOf("--key") + 1]
  : process.env.HECLUS_POYO_API_KEY;

if (!key) {
  console.error("No PoYo key. Set HECLUS_POYO_API_KEY or pass --key <value>.");
  process.exit(2);
}

const src = fs.readFileSync(new URL("../lib/poyo/imageModels.ts", import.meta.url), "utf8");
const models = [...src.matchAll(/m\("([^"]+)",\s*"([^"]+)",\s*([\d.]+),\s*(true|false)/g)]
  .map(([, id, name, credits, verified]) => ({ id, name, credits: Number(credits), verified: verified === "true" }));

console.log(`${models.length} models in the catalog, ${models.filter(m => !m.verified).length} unverified`);
console.log(SPEND ? "MODE: real submits, this spends credits\n" : "MODE: probe, spends nothing\n");

const UNKNOWN_MODEL = /model.*(not found|not supported|unknown|invalid|does not exist)|no such model/i;
const BAD_INPUT = /prompt|input|required|empty|missing/i;

async function probe(model) {
  const body = SPEND
    ? { model: model.id, input: { prompt: "a single grey square", size: "1:1" } }
    : { model: model.id, input: { prompt: "" } };

  const res = await fetch("https://api.poyo.ai/api/generate/submit", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch { /* non-JSON body falls through to raw */ }

  const message = json?.error?.message ?? json?.message ?? text.slice(0, 200);

  if (res.ok && json?.code === 200 && json?.data?.task_id) {
    return { verdict: "VALID", detail: SPEND ? `task ${json.data.task_id}` : "accepted an empty prompt" };
  }
  if (UNKNOWN_MODEL.test(message)) return { verdict: "WRONG ID", detail: message };
  if (BAD_INPUT.test(message)) return { verdict: "VALID", detail: `rejected the input, not the model: ${message}` };
  return { verdict: "UNKNOWN", detail: `${res.status}: ${message}` };
}

const results = [];
for (const model of models) {
  let r;
  try { r = await probe(model); }
  catch (e) { r = { verdict: "UNKNOWN", detail: e instanceof Error ? e.message : String(e) }; }
  results.push({ ...model, ...r });
  const flag = model.verified ? "" : "  (currently withheld from the picker)";
  console.log(`${r.verdict.padEnd(9)} ${model.id.padEnd(26)} ${r.detail}${flag}`);
  // PoYo does not publish a rate limit for submit; pace it rather than find out.
  await new Promise((r) => setTimeout(r, 400));
}

const valid = results.filter((r) => r.verdict === "VALID" && !r.verified);
const wrong = results.filter((r) => r.verdict === "WRONG ID");
const unsure = results.filter((r) => r.verdict === "UNKNOWN");

console.log("\n--- summary ---");
console.log(`${valid.length} inferred ids confirmed. Set verified: true on these:`);
for (const r of valid) console.log(`    ${r.id}`);
if (wrong.length) {
  console.log(`\n${wrong.length} ids are wrong and need the real string from PoYo's dashboard:`);
  for (const r of wrong) console.log(`    ${r.id}  (${r.name})`);
}
if (unsure.length) {
  console.log(`\n${unsure.length} inconclusive — re-run these with --spend:`);
  for (const r of unsure) console.log(`    ${r.id}  ${r.detail}`);
}
