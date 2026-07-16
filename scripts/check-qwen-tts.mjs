// Verify the Qwen3-TTS (Replicate) integration once REPLICATE_API_TOKEN is
// set. Two things the code can't confirm without a token:
//   1. The live input schema of qwen/qwen3-tts — compared against the
//      field names lib/replicate/tts.ts buildInput() sends.
//   2. An actual synthesis round-trip (pass --synth to spend one tiny run).
//
// Usage:  node scripts/check-qwen-tts.mjs [--synth]

import "dotenv/config";

const token = (process.env.REPLICATE_API_TOKEN ?? "").trim();
if (!token) {
  console.error("REPLICATE_API_TOKEN is not set — add it to .env first.");
  process.exit(1);
}

const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

// 1) Schema check
const modelRes = await fetch("https://api.replicate.com/v1/models/qwen/qwen3-tts", { headers });
if (!modelRes.ok) {
  console.error(`Model lookup failed: ${modelRes.status} ${await modelRes.text()}`);
  process.exit(1);
}
const model = await modelRes.json();
const schema = model.latest_version?.openapi_schema?.components?.schemas?.Input;
console.log("model:", model.owner + "/" + model.name, "| latest version:", model.latest_version?.id?.slice(0, 12));
if (schema?.properties) {
  console.log("\nInput fields:");
  for (const [k, v] of Object.entries(schema.properties)) {
    const enums = v.enum ?? v.allOf?.[0]?.enum;
    console.log(` - ${k} (${v.type ?? "ref"})${v.default !== undefined ? ` default=${JSON.stringify(v.default)}` : ""}${enums ? ` enum=[${enums.join(", ")}]` : ""}`);
  }
  const sent = ["text", "speaker", "mode", "language"];
  const missing = sent.filter((k) => !(k in schema.properties));
  if (missing.length) {
    console.log(`\n⚠️  buildInput() sends [${missing.join(", ")}] which the schema doesn't list — update lib/replicate/tts.ts buildInput().`);
  } else {
    console.log("\n✓ buildInput() field names all exist in the live schema.");
  }
} else {
  console.log("No Input schema found on latest_version — inspect manually:", JSON.stringify(model.latest_version?.openapi_schema ?? {}).slice(0, 400));
}

// 2) Optional live synthesis
if (process.argv.includes("--synth")) {
  console.log("\nRunning a test synthesis (Serena)…");
  const res = await fetch("https://api.replicate.com/v1/models/qwen/qwen3-tts/predictions", {
    method: "POST",
    headers: { ...headers, Prefer: "wait=60" },
    body: JSON.stringify({ input: { text: "Hello from Heclus — this is a Qwen voice test.", speaker: "Serena", mode: "custom_voice", language: "auto" } }),
  });
  const pred = await res.json();
  console.log("status:", pred.status, "| error:", pred.error ?? "none");
  console.log("output:", JSON.stringify(pred.output)?.slice(0, 300));
}
