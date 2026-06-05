// Registry of Anthropic-side models that admin accounts can pick from
// at each workflow step. Non-admin requests always use DEFAULT_MODEL —
// the model picker in the UI is gated by useIsAdmin, and the workflow
// routes refuse model overrides from non-admin callers.

export interface AnthropicModelOption {
  id: string;
  name: string;
  notes?: string;
}

// Includes both current 4.X models and older 3.X / 3.5 ones for admin
// experiments. The "legacy" notes flag IDs that may have been
// deprecated by Anthropic depending on the current rotation — the
// server-side resolveAnthropicModel allowlist keeps the request from
// blowing up with arbitrary strings, but a deprecated ID returns a
// "model not found" error from the API itself. Test before relying on.
export const ANTHROPIC_MODEL_OPTIONS: AnthropicModelOption[] = [
  // Claude 4.X — current generation
  { id: "claude-opus-4-7",   name: "Claude Opus 4.7",   notes: "Default — best quality" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", notes: "Faster, ~3× cheaper" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", notes: "Fastest, cheapest" },

  // Claude 3.5 — previous generation, generally still callable
  { id: "claude-3-5-sonnet-20241022", name: "Claude Sonnet 3.5 (Oct 2024)", notes: "Previous-gen mid tier" },
  { id: "claude-3-5-haiku-20241022",  name: "Claude Haiku 3.5 (Oct 2024)",  notes: "Previous-gen small, fast" },

  // Claude 3 — older generation, may be deprecated
  { id: "claude-3-opus-20240229",  name: "Claude Opus 3 (Feb 2024)",  notes: "Legacy flagship — may be deprecated" },
  { id: "claude-3-haiku-20240307", name: "Claude Haiku 3 (Mar 2024)", notes: "Legacy small — may be deprecated" },
];

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-7";

// Safety check before honoring a model override coming from the client.
// Keeps non-admin callers from passing arbitrary strings into the SDK.
export function isAllowedAnthropicModel(model: string | undefined | null): boolean {
  if (!model) return false;
  return ANTHROPIC_MODEL_OPTIONS.some((m) => m.id === model);
}
