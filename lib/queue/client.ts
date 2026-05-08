import { Queue } from "bullmq";
import { Redis } from "@upstash/redis";

export const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// BullMQ needs ioredis-compatible connection
export const queueConnection = {
  host: process.env.UPSTASH_REDIS_HOST ?? "localhost",
  port: parseInt(process.env.UPSTASH_REDIS_PORT ?? "6379"),
  password: process.env.UPSTASH_REDIS_PASSWORD,
  tls: process.env.UPSTASH_REDIS_TLS === "true" ? {} : undefined,
};

export const videoQueue = new Queue("video-generation", {
  connection: queueConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 5000 },
    removeOnComplete: 100,
    removeOnFail: 100,
  },
});
