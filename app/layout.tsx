import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ZoomProvider } from "@/components/ZoomProvider";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";
import { Providers } from "@/components/Providers";

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" });

export const metadata: Metadata = {
  title: "aiTrends YT Workflow",
  description: "Analyze channels, generate scripts, create voiceovers, images, and video clips",
  manifest: "/manifest.json",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "aiTrends",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} h-full`}>
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
