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
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
