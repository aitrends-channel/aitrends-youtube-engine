const isDev = process.env.NODE_ENV === "development";

export const WORKER_URL = isDev
  ? (process.env.WORKER_URL_LOCAL ?? "http://localhost:3010")
  : (process.env.WORKER_URL_PRODUCTION ?? "https://video-worker-9mob.onrender.com");
