import { Queue } from "bullmq";

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
