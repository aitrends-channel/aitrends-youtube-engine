/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**" },
    ],
  },
  experimental: {
    serverComponentsExternalPackages: ["bullmq"],
    serverActions: {
      bodySizeLimit: "10mb",
    },
  },
};

export default nextConfig;
