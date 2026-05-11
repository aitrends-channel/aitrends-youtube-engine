import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
    ],
  },
  serverExternalPackages: ["bullmq", "fluent-ffmpeg", "ffmpeg-static", "ffprobe-static"],
  serverActions: {
    bodySizeLimit: "10mb",
  },
};

export default nextConfig;
