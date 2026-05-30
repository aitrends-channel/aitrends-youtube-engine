import { supabase } from "@/lib/supabase/client";

export interface SystemLogEntry {
  level: "error" | "warn" | "info";
  source: string;            // e.g. "channel_analysis", "tts", "assemble"
  message: string;
  userId?: string;
  projectId?: string;
  metadata?: Record<string, unknown>;
}

// Fire-and-forget insert. Logging must never crash or block the request
// path — any failure here is swallowed and forwarded to the console so
// at least it shows up in server logs.
export async function logSystemEvent(entry: SystemLogEntry): Promise<void> {
  try {
    const { error } = await supabase.from("system_logs").insert({
      level: entry.level,
      source: entry.source,
      message: entry.message,
      user_id: entry.userId ?? null,
      project_id: entry.projectId ?? null,
      metadata: entry.metadata ?? {},
    });
    if (error) console.warn("[system-logger] insert failed:", error.message);
  } catch (err) {
    console.warn("[system-logger] threw:", err);
  }
}
