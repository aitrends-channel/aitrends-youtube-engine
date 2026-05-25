import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorkerRegistrar } from "@/components/ServiceWorkerRegistrar";
import { Providers } from "@/components/Providers";

const BASE_URL = "https://app.heclus.io";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  title: "Heclus",
  description: "Analyze channels, generate scripts, create voiceovers, images, and video clips",
  manifest: "/manifest.json",
  metadataBase: new URL(BASE_URL),
  icons: {
    icon: [
      { url: "/heclus.ico" },
      { url: "/heclus-icon.png", type: "image/png", sizes: "512x512" },
    ],
    apple: "/heclus-icon-white.png",
  },
  openGraph: {
    title: "Heclus",
    description: "Analyze channels, generate scripts, create voiceovers, images, and video clips",
    url: BASE_URL,
    siteName: "Heclus",
    images: [{ url: "/heclus-icon.png", width: 512, height: 512 }],
    type: "website",
  },
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Heclus",
  },
};

const organizationSchema = {
  "@context": "https://schema.org",
  "@type": "Organization",
  name: "Heclus",
  url: BASE_URL,
  logo: `${BASE_URL}/heclus-icon.png`,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full" style={{ fontFamily: "'Inter Variable', sans-serif" }}>
      <head>
        <link rel="icon" href="/heclus.ico" />
        <meta name="theme-color" content="#0f0a0f" />
        <meta name="mobile-web-app-capable" content="yes" />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(organizationSchema) }}
        />
      </head>
      <body className="min-h-full bg-background text-foreground antialiased" suppressHydrationWarning>
        <ServiceWorkerRegistrar />
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
