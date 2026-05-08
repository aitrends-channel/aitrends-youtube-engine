export type PhaseKey = "channel" | "topic" | "script" | "visuals" | "prompts" | "thumbnails" | "generate" | "assemble";
export type ThemeId = "geometric" | "minimal" | "neon" | "sharp" | "ascii";

export interface IconTheme {
  id: ThemeId;
  name: string;
  icons: Record<PhaseKey, string>;
  doneIcon: string;
}

export const ICON_THEMES: Record<ThemeId, IconTheme> = {
  geometric: {
    id: "geometric",
    name: "Geometric",
    icons: { channel: "◎", topic: "◉", script: "✦", visuals: "◈", prompts: "⬡", thumbnails: "⬟", generate: "⚡", assemble: "▶" },
    doneIcon: "✓",
  },
  minimal: {
    id: "minimal",
    name: "Minimal",
    icons: { channel: "○", topic: "●", script: "·", visuals: "□", prompts: "◇", thumbnails: "▱", generate: "→", assemble: "▷" },
    doneIcon: "✓",
  },
  neon: {
    id: "neon",
    name: "Neon",
    icons: { channel: "⬡", topic: "⊙", script: "⊕", visuals: "⊞", prompts: "⊗", thumbnails: "⊟", generate: "⇾", assemble: "⊳" },
    doneIcon: "✔",
  },
  sharp: {
    id: "sharp",
    name: "Sharp",
    icons: { channel: "▷", topic: "▸", script: "✎", visuals: "▣", prompts: "⟡", thumbnails: "▪", generate: "▶", assemble: "►" },
    doneIcon: "■",
  },
  ascii: {
    id: "ascii",
    name: "ASCII",
    icons: { channel: "[C]", topic: "[T]", script: "[S]", visuals: "[V]", prompts: "[P]", thumbnails: "[N]", generate: "[G]", assemble: "[A]" },
    doneIcon: "[x]",
  },
};

export const THEME_ORDER: ThemeId[] = ["geometric", "minimal", "neon", "sharp", "ascii"];
