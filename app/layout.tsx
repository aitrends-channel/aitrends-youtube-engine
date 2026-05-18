import type { Metadata } from "next";
import "./globals.css";
import { ZoomProvider } from "@/components/ZoomProvider";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";
import { Providers } from "@/components/Providers";

export const metadata: Metadata = {
  title: "Heclus",
  description: "Analyze channels, generate scripts, create voiceovers, images, and video clips",
  manifest: "/manifest.json",
  icons: {
    icon: [
      { url: "/logo.jpeg", type: "image/jpeg" },
      { url: "/logo.svg", type: "image/svg+xml" },
    ],
    apple: "/logo.jpeg",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Heclus",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full" style={{ fontFamily: "'Inter Variable', sans-serif" }}>
      <head>
        <meta name="theme-color" content="#0f0a0f" />
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      <body className="min-h-full bg-background text-foreground antialiased" suppressHydrationWarning>
        <ServiceWorkerRegistrar />
        <ZoomProvider />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
