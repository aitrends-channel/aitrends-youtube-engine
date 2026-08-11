import "server-only";
import { supabase } from "@/lib/supabase/client";

// The admin-editable half of what the agent knows. Read on every question, with
// a short cache so a busy chat does not hit the database once per turn — and a
// short one deliberately, because the reason this is in the database is that
// somebody needs a wrong answer to stop being given within a minute.

export interface KnowledgeEntry {
  id: string;
  title: string;
  content: string;
  enabled: boolean;
  sort_order: number;
  updated_by: string | null;
  updated_at: string;
}

const CACHE_MS = 60_000;
let cache: { at: number; text: string } | null = null;

export function invalidateKnowledgeCache(): void {
  cache = null;
}

/** The enabled entries, formatted for the prompt. Empty string when there are
 *  none, so the caller can append it unconditionally. */
export async function getKnowledgeBriefing(): Promise<string> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.text;
  try {
    const { data, error } = await supabase
      .from("support_knowledge")
      .select("title, content")
      .eq("enabled", true)
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { title: string; content: string }[];
    const text = rows.length
      ? [
          "NOTES FROM THE TEAM (added by an admin; these outrank the briefing above",
          "when they conflict, because they are newer):",
          ...rows.map((r) => `- ${r.title.trim()}: ${r.content.trim()}`),
        ].join("\n")
      : "";
    cache = { at: Date.now(), text };
    return text;
  } catch (e) {
    // Missing notes are better than a failed chat: the agent still has the
    // permanent briefing and the account evidence.
    console.warn("[support-agent] knowledge read failed:", e instanceof Error ? e.message : e);
    return "";
  }
}
