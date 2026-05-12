import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// On Vercel, request.url is the internal localhost URL — use forwarded headers to get the real public origin.
export function getAppUrl(request: Request): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  if (host) return `${proto}://${host}`;
  return new URL(request.url).origin;
}

// Client-side: picks local or production URL based on NODE_ENV.
export function getClientAppUrl(): string {
  return process.env.NODE_ENV === "production"
    ? (process.env.NEXT_PUBLIC_APP_URL_PRODUCTION ?? "")
    : (process.env.NEXT_PUBLIC_APP_URL_LOCAL ?? "");
}
