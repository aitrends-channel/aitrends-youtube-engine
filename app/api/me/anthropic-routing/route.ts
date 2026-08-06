export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { getRequiredUser } from "@/lib/supabase/auth";
import { getSettings } from "@/lib/settings";
import { getRoutingForUser, isClientPaid } from "@/lib/claude/routing";
import type { User } from "@supabase/supabase-js";

// What the client needs to decide whether offering "run this on my own
// Anthropic key" is honest:
//
//   hasKey / enabled — whether they've supplied a key and switched it on.
//   eligible         — whether their own key is what pays for that step at
//                      all. When an admin has routed a step to heclus_kie or
//                      heclus_direct, Heclus is covering it and the client's
//                      key is never consulted (see getRoutingForUser), so a
//                      button promising to reroute it would do nothing.
//
// Deliberately exposes eligibility, not the routing value itself — which
// provider Heclus pays is not the client's business.
export interface MyAnthropicRouting {
  hasKey: boolean;
  enabled: boolean;
  eligible: { image_prompts: boolean; video_prompts: boolean };
}

export async function GET() {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  try {
    const [settings, imageRouting, videoRouting] = await Promise.all([
      getSettings(user.id),
      getRoutingForUser(user.id, "image_prompts"),
      getRoutingForUser(user.id, "video_prompts"),
    ]);
    return NextResponse.json({
      hasKey: !!settings.anthropic_api_key,
      enabled: settings.anthropic_direct_enabled,
      eligible: {
        image_prompts: isClientPaid(imageRouting),
        video_prompts: isClientPaid(videoRouting),
      },
    } satisfies MyAnthropicRouting);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to read routing" },
      { status: 500 },
    );
  }
}
