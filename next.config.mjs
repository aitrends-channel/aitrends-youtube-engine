/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
    ],
  },
  experimental: {
    serverComponentsExternalPackages: ["bullmq", "fluent-ffmpeg", "ffmpeg-static", "ffprobe-static"],
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
