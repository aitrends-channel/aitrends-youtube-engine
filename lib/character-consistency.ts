import { supabase } from "@/lib/supabase/client";
import { getSettings } from "@/lib/settings";

export interface ConsistencyConfig {
  text: string;
  /** apply/detach switch — false leaves the base prompt untouched. */
  append: boolean;
}

// Prepend the character-consistency text to a base image prompt so it
// leads the prompt sent to the image model. Returns the base untouched
// when detached or when the text is empty. A blank line keeps the
// consistency statement visually distinct from the per-beat prompt.
export function applyConsistency(base: string, text: string, apply: boolean): string {
  const t = text.trim();
  const b = base.trim();
  if (!apply || !t) return b;
  return `${t}\n\n${b}`;
}

// Resolve the effective consistency text + append switch for a project.
//
//   text   = project text (if set) ?? account default ?? ""
//   append = project switch (defaults TRUE)
//
// NULL text on the project row = "inherit the account default"; an
// explicit '' on the project row = "no text for this project".
// getSettings() is cached (60s) so this is cheap on the hot path.
export async function resolveConsistency(userId: string, projectId: string): Promise<ConsistencyConfig> {
  const [{ data: proj }, account] = await Promise.all([
    supabase
      .from("projects")
      .select("character_consistency_text, character_consistency_append")
      .eq("id", projectId)
      .eq("user_id", userId)
      .single(),
    getSettings(userId),
  ]);

  const projText = proj?.character_consistency_text as string | null | undefined;
  const projAppend = proj?.character_consistency_append as boolean | null | undefined;

  return {
    text: projText ?? account.character_consistency_text ?? "",
    append: projAppend ?? true,
  };
}
