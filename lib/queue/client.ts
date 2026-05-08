import { Queue } from "bullmq";
import { Redis } from "@upstash/redis";

// Lazy singletons — connections are only opened inside request handlers,
// never at module load time (which would crash the Next.js build).

let _redis: Redis | null = null;
export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
  }
  return _redis;
}

export function getQueueConnection() {
  return {
    host: process.env.UPSTASH_REDIS_HOST ?? "localhost",
    port: parseInt(process.env.UPSTASH_REDIS_PORT ?? "6379"),
    password: process.env.UPSTASH_REDIS_PASSWORD,
    tls: process.env.UPSTASH_REDIS_TLS === "true" ? {} : undefined,
  };
}

let _videoQueue: Queue | null = null;
export function getVideoQueue(): Queue {
  if (!_videoQueue) {
    _videoQueue = new Queue("video-generation", {
      connection: getQueueConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    });
  }
  return _videoQueue;
}
