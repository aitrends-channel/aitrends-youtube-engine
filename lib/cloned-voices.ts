import { supabase } from "@/lib/supabase/client";

// Voices a user cloned on one of Heclus's own provider accounts. The voice
// id keeps its provider's normal prefix ("ai33/…"), so synthesis already
// routes to Heclus's token with no special casing — ownership is the only
// thing this module adds.
export interface ClonedVoice {
  id: string;
  provider: string;
  provider_voice_id: string;
  name: string;
  sample_url: string | null;
  created_at: string;
}

export function clonedVoiceId(v: Pick<ClonedVoice, "provider" | "provider_voice_id">): string {
  return `${v.provider}/${v.provider_voice_id}`;
}

export async function listClonedVoices(userId: string): Promise<ClonedVoice[]> {
  const { data, error } = await supabase
    .from("cloned_voices")
    .select("id, provider, provider_voice_id, name, sample_url, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as ClonedVoice[];
}

// Clones live on shared upstream accounts, so possessing an id proves
// nothing: without this check any user could synthesize with another
// user's clone by passing its id. Server callers run on the service key,
// which bypasses RLS, so the check has to be explicit. Returns true for
// ids that aren't clones at all — those are public catalog voices.
export async function canUseVoice(userId: string, voiceId: string): Promise<boolean> {
  const slash = voiceId.indexOf("/");
  if (slash < 0) return true;
  const provider = voiceId.slice(0, slash);
  const providerVoiceId = voiceId.slice(slash + 1);

  const { data, error } = await supabase
    .from("cloned_voices")
    .select("user_id")
    .eq("provider", provider)
    .eq("provider_voice_id", providerVoiceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return !data || data.user_id === userId;
}
