// KIE+Opus occasionally ignores `tool_choice` forcing and emits the
// intended tool call as plain text — sometimes wrapped in a fake
// `<tool_calls>[{"input": {...}}]` structure, sometimes as bare JSON
// with commentary around it. This helper tries multiple shapes to
// recover the structured input so we don't lose the whole turn.
//
// Returns the parsed input object (the value that *would* have been
// the tool's `input` field), or null if nothing parseable is found.
export function extractToolInputFromText(raw: string): Record<string, unknown> | null {
  if (!raw) return null;

  // Strategy 1: `<tool_calls>[{...,"input":{...}}]` wrapper. Walk the
  // string after `"input"` and bracket-count to the matching `}`.
  const inputKey = raw.indexOf('"input"');
  if (inputKey !== -1) {
    const braceStart = raw.indexOf("{", inputKey);
    if (braceStart !== -1) {
      const end = matchingBrace(raw, braceStart);
      if (end !== -1) {
        try { return JSON.parse(raw.slice(braceStart, end + 1)) as Record<string, unknown>; }
        catch { /* fall through */ }
      }
    }
  }

  // Strategy 2: greedy first-to-last brace and unwrap a tool-call shape
  // if present.
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) {
    try {
      const parsed = JSON.parse(raw.slice(first, last + 1));
      if (parsed && typeof parsed === "object") {
        // If it looks like a tool_use shape, return its input
        const p = parsed as Record<string, unknown>;
        if (p.input && typeof p.input === "object") return p.input as Record<string, unknown>;
        return p;
      }
    } catch { /* fall through */ }
  }

  return null;
}

function matchingBrace(s: string, openIdx: number): number {
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// A second quirk, and a different one: the tool call arrives properly formed,
// but the model has put the entire payload into the first property as a JSON
// string. Sonnet 5 does this on the beats tool, returning
//
//   { "beats": "{\"beats\": [ {\"beatNumber\": 1, ... } ]}" }
//
// rather than the array the schema asks for. The work is all there and correct;
// only the wrapping is wrong, so throwing the turn away costs a chunk of script
// and the tokens that produced it for nothing.
//
// Unwraps one layer, and only when it yields the array the caller wanted.
// Anything else is returned untouched, so a genuinely malformed response still
// fails validation rather than being coerced into something plausible.
export function unwrapNestedToolInput(
  input: Record<string, unknown> | null,
  key: string,
): Record<string, unknown> | null {
  if (!input) return input;
  const value = input[key];
  if (typeof value !== "string") return input;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return input;

  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); }
  catch { return input; }

  if (Array.isArray(parsed)) return { ...input, [key]: parsed };
  if (parsed && typeof parsed === "object") {
    const inner = (parsed as Record<string, unknown>)[key];
    if (Array.isArray(inner)) return { ...input, ...(parsed as Record<string, unknown>) };
  }
  return input;
}
