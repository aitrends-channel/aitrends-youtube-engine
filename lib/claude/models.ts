// Registry of Anthropic-side models that admin accounts can pick from
// at each workflow step. Non-admin requests always use DEFAULT_MODEL —
// the model picker in the UI is gated by useIsAdmin, and the workflow
// routes refuse model overrides from non-admin callers.

export interface AnthropicModelOption {
  id: string;
  name: string;
  notes?: string;
}

export const ANTHROPIC_MODEL_OPTIONS: AnthropicModelOption[] = [
  { id: "claude-opus-4-7",   name: "Claude Opus 4.7",   notes: "Default — best quality" },
  { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", notes: "Faster, ~3× cheaper" },
  { id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", notes: "Fastest, cheapest" },
];

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-7";

// Safety check before honoring a model override coming from the client.
// Keeps non-admin callers from passing arbitrary strings into the SDK.
export function isAllowedAnthropicModel(model: string | undefined | null): boolean {
  if (!model) return false;
  return ANTHROPIC_MODEL_OPTIONS.some((m) => m.id === model);
}
