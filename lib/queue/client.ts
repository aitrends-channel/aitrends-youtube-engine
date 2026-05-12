export function getQueueConnection() {
  return {
    host: process.env.UPSTASH_REDIS_HOST ?? "localhost",
    port: parseInt(process.env.UPSTASH_REDIS_PORT ?? "6379"),
    password: process.env.UPSTASH_REDIS_PASSWORD,
    tls: process.env.UPSTASH_REDIS_TLS === "true" ? {} : undefined,
  };
}

let _videoQueue: Awaited<ReturnType<typeof createQueue>> | null = null;

async function createQueue() {
  const { Queue } = await import("bullmq");
  return new Queue("video-generation", {
    connection: getQueueConnection(),
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    },
  });
}

export async function getVideoQueue() {
  if (!_videoQueue) {
    _videoQueue = await createQueue();
  }
  return _videoQueue;
}
