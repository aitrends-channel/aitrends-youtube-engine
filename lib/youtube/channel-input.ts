// Is this string a channel, or something else on YouTube?
//
// Pasting a video link into the channel field is the commonest mistake at the
// Channel Setup step, and it used to fail late and badly: parseChannelUrl ends
// in a catch-all that treats an unrecognised path as a handle, so
// youtube.com/watch?v=... became a lookup for a channel named "watch", and the
// user got a generic "channel not found" after the request had already gone to
// YouTube. This says no first, and says which mistake was made.
//
// It runs on the client (before Analyze spends anything) and on the server
// (because a client check is a courtesy, not a guarantee). No imports, so it is
// safe in both.

export type ChannelInputProblem =
  | "empty"
  | "video"
  | "shorts"
  | "playlist"
  | "search"
  | "not-youtube";

export interface ChannelInputCheck {
  ok: boolean;
  problem?: ChannelInputProblem;
  /** The video or playlist id, when the input carried one. */
  detail?: string;
}

const OK: ChannelInputCheck = { ok: true };

/** Accepts what parseChannelUrl accepts, and names what it does not. */
export function checkChannelInput(input: string): ChannelInputCheck {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: false, problem: "empty" };

  // Bare channel id, and bare handle with or without the @. Checked before URL
  // parsing for the same reason parseChannelUrl does: neither is a URL.
  if (/^UC[\w-]{20,}$/.test(raw)) return OK;
  if (/^@?[\w.-]+$/.test(raw) && !raw.includes("/") && !raw.includes(":")) return OK;

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, "")}`);
  } catch {
    // Not parseable as a URL and not a bare handle: let the server try it as a
    // handle rather than blocking on a shape we do not recognise.
    return OK;
  }

  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  if (host === "youtu.be") {
    // Short links are only ever a video.
    return { ok: false, problem: "video", detail: url.pathname.replace(/^\//, "") || undefined };
  }
  if (host !== "youtube.com") return { ok: false, problem: "not-youtube" };

  const path = url.pathname;
  const videoId = url.searchParams.get("v");

  // Channel forms, in the same order parseChannelUrl reads them.
  if (/^\/channel\/UC[\w-]+/.test(path)) return OK;
  if (/^\/@[\w.-]+/.test(path)) return OK;
  if (/^\/(user|c)\/[\w.-]+/.test(path)) return OK;

  if (path === "/watch" || videoId) return { ok: false, problem: "video", detail: videoId ?? undefined };
  if (/^\/(shorts|live|embed|v)\//.test(path)) {
    const id = path.split("/")[2] || undefined;
    return { ok: false, problem: path.startsWith("/shorts/") ? "shorts" : "video", detail: id };
  }
  if (path === "/playlist" || url.searchParams.get("list")) {
    return { ok: false, problem: "playlist", detail: url.searchParams.get("list") ?? undefined };
  }
  if (path === "/results") return { ok: false, problem: "search" };

  // A legacy custom URL (youtube.com/SomeChannel) still resolves via forHandle,
  // so an unrecognised single-segment path is allowed through.
  return OK;
}

/** What to tell the customer, in as few words as it takes. */
export function channelInputMessage(problem: ChannelInputProblem): {
  title: string;
  body: string;
  hint: string;
} {
  const findIt = "Open the channel itself and copy its address: youtube.com/@name";
  switch (problem) {
    case "video":
      return {
        title: "That is a video link",
        body: "Heclus needs the channel it came from, not one video.",
        hint: "Click the channel name under the video, then copy that address.",
      };
    case "shorts":
      return {
        title: "That is a Short link",
        body: "Heclus needs the channel it came from, not one video.",
        hint: "Click the channel name on the Short, then copy that address.",
      };
    case "playlist":
      return {
        title: "That is a playlist link",
        body: "Heclus needs the channel, not a playlist from it.",
        hint: findIt,
      };
    case "search":
      return {
        title: "That is a search page",
        body: "Heclus needs one channel.",
        hint: findIt,
      };
    case "not-youtube":
      return {
        title: "That is not a YouTube link",
        body: "Heclus models YouTube channels.",
        hint: findIt,
      };
    case "empty":
      return {
        title: "Add a channel first",
        body: "Heclus needs a channel to model.",
        hint: "Paste its address, or just the handle: @name",
      };
  }
}
