// Client-side 1Click kickoff, shared by every entry point (the dashboard's
// New Video chooser, and the setup stepper once it finishes) so the fork
// payload and the start-then-tick order live in exactly one place.

/** Engage autopilot on an existing project and nudge the orchestrator so
 *  the first step begins while the user is still watching. */
export async function startOneClick(projectId: string): Promise<void> {
  const res = await fetch("/api/one-click/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId }),
  });
  const d = (await res.json().catch(() => ({}))) as { error?: string; code?: string };
  if (!res.ok) {
    const err = new Error(d.error ?? `1Click start failed (${res.status})`) as Error & { code?: string };
    err.code = d.code;
    throw err;
  }
  // Fire-and-forget: the tick loop would pick the project up anyway, this
  // just avoids waiting for the next scheduled pass.
  void fetch("/api/one-click/tick", { method: "POST" }).catch(() => {});
}

export interface KickoffChannelInfo {
  channelName: string;
  topVideos?: { duration?: string }[];
  [k: string]: unknown;
}

/** Look up a channel by URL. Same endpoint and error handling the channel
 *  step uses, including its guard against non-JSON runtime errors. */
export async function fetchChannelInfo(
  channelUrl: string,
  contentType: "long" | "shorts" | "both",
): Promise<KickoffChannelInfo> {
  const res = await fetch("/api/youtube/channel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channelUrl, contentType }),
  });
  // Read once as text: a platform-level failure (timeout, OOM) returns
  // plain text, and res.json() on that throws something unreadable.
  const bodyText = await res.text();
  let parsed: { error?: string; [k: string]: unknown } | null = null;
  try { parsed = bodyText ? JSON.parse(bodyText) : null; } catch { /* non-JSON body */ }
  if (!res.ok) throw new Error(parsed?.error ?? bodyText ?? `Channel fetch failed (${res.status})`);
  return parsed as unknown as KickoffChannelInfo;
}

/** The user's existing niche for this channel, if any. Mirrors the channel
 *  step's dedup guard: creating a second niche for the same channel burns a
 *  slot and re-runs analysis for nothing. */
export async function findExistingNiche(channelName: string): Promise<{ id: string; channelName: string } | null> {
  const target = channelName.trim().toLowerCase();
  const res = await fetch("/api/projects");
  if (!res.ok) return null;
  const projects = (await res.json()) as Array<{ id: string; channel_name: string | null }>;
  const match = projects.find((p) => (p.channel_name ?? "").trim().toLowerCase() === target);
  return match ? { id: match.id, channelName } : null;
}

/** Create a niche for a freshly-looked-up channel and engage 1Click on it.
 *  Mirrors the channel step's oneclick branch: save the channel, engage
 *  autopilot, then kick transcript + Claude analysis SERVER-side so the
 *  slow work happens off-screen while the user watches the run view. */
export async function createAndStartOneClickForChannel(opts: {
  channelUrl: string;
  contentType: "long" | "shorts" | "both";
  info: KickoffChannelInfo;
  topicHint?: string;
}): Promise<string> {
  const createRes = await fetch("/api/projects", { method: "POST" });
  const created = (await createRes.json().catch(() => ({}))) as {
    id?: string; limitReached?: boolean; limit?: number; nichesUsed?: number; plan?: string;
  };
  if (createRes.status === 403 && created.limitReached) {
    const err = new Error("You've reached your niche limit. Upgrade your plan to add more.") as Error & { limitReached?: boolean };
    err.limitReached = true;
    throw err;
  }
  if (!created.id) throw new Error("Failed to create project");

  await fetch(`/api/projects/${created.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      channel_url: opts.channelUrl,
      channel_name: opts.info.channelName,
      channel_info: opts.info,
      content_type: opts.contentType,
    }),
  });

  await startOneClick(created.id);

  // Server-side analysis; the orchestrator waits below state 6 until it
  // lands. keepalive so navigating away doesn't cancel it.
  void fetch("/api/one-click/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ projectId: created.id, topicHint: opts.topicHint }),
    keepalive: true,
  }).catch(() => {});

  return created.id;
}

/** Fork a niche's channel work (analysis, ideas, visual profile already
 *  done) into a fresh video and engage 1Click on it. Returns the new
 *  project id. No selectedTopic — 1Click picks per the user's config. */
export async function forkAndStartOneClick(sourceProjectId: string): Promise<string> {
  const full = await (await fetch(`/api/projects/${sourceProjectId}`)).json();
  const forkRes = await fetch("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fork: {
        channelUrl:        full.channel_url,
        channelName:       full.channel_name,
        channelAnalysis:   full.channel_analysis,
        channelInfo:       full.channel_info,
        transcripts:       full.transcripts,
        visualProfile:     full.visual_profile,
        thumbnailAnalysis: full.thumbnail_analysis,
        videoIdeas:        full.video_ideas,
      },
    }),
  });
  const newProject = (await forkRes.json().catch(() => ({}))) as { id?: string; limitReached?: boolean };
  if (forkRes.status === 403 && newProject.limitReached) {
    throw new Error("You've reached your niche limit. Upgrade your plan to add more.");
  }
  if (!newProject.id) throw new Error("Couldn't create the video.");
  await startOneClick(newProject.id);
  return newProject.id;
}
