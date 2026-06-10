/** @type {import('next').NextConfig} */
const nextConfig = {
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
