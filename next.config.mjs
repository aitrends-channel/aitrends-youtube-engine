// Where the in-app AI support chat is switched on.
//
// The flag it feeds (lib/feature-flags.ts) is read in a client component, so it
// has to be a NEXT_PUBLIC_ value inlined at build time. Vercel's own
// VERCEL_ENV / VERCEL_GIT_COMMIT_REF are build-time-only and never reach the
// browser, so they are translated here instead.
//
// Deciding it in the repo rather than in the Vercel dashboard means the rule is
// reviewable, cannot silently drift per environment, and does not have to be
// re-applied when a project is recreated. An explicit env var still wins, so a
// dashboard value or a local .env can override either way.
//
// Production is deliberately absent from the condition: main deploys with the
// chat off until that is changed here, on purpose.
const supportChatEnabled =
  process.env.NEXT_PUBLIC_SUPPORT_CHAT_ENABLED
  ?? ((process.env.VERCEL_ENV === "preview" || process.env.VERCEL_GIT_COMMIT_REF === "staging")
    ? "true"
    : "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: {
    NEXT_PUBLIC_SUPPORT_CHAT_ENABLED: supportChatEnabled,
  },
  // /balance was the route until it was renamed to /billing. Kept as a
  // permanent redirect rather than dropped: the old path is in bookmarks, in
  // the browser history of anyone who has topped up, and in any link already
  // sent out.
  async redirects() {
    return [{ source: "/balance", destination: "/billing", permanent: true }];
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
    ],
  },
  experimental: {
    // ffmpeg-static / ffprobe-static ship a native binary that isn't
    // a JS module — webpack can't bundle it, and trying to import via
    // a chunk path produces `spawn .next/server/vendor-chunks/ffmpeg
    // ENOENT` at runtime. Leaving these packages external means Next
    // uses real Node `require()`, which resolves to the binary inside
    // node_modules at its installed path. fluent-ffmpeg is here too
    // because it loads ffmpeg-static dynamically.
    serverComponentsExternalPackages: [
      "bullmq",
      "ffmpeg-static",
      "ffprobe-static",
      "fluent-ffmpeg",
    ],
    // Vercel's serverless bundler walks the JS dependency graph but
    // doesn't trace native binaries inside node_modules. Without an
    // explicit include the ffmpeg binary isn't shipped to the Lambda,
    // and the runtime spawn fails with
    // `spawn /var/task/node_modules/ffmpeg-static/ffmpeg ENOENT`.
    // Listing the binary under the concat route's key forces it into
    // that function's deployment bundle.
    outputFileTracingIncludes: {
      "/api/projects/[projectId]/voiceover/concat": [
        "./node_modules/ffmpeg-static/ffmpeg",
        "./node_modules/ffmpeg-static/index.js",
      ],
    },
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
