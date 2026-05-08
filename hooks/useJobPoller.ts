"use client";

import { useState, useEffect, useRef } from "react";
import type { JobStatus } from "@/lib/types";

export function useJobPoller(jobIds: string[], enabled: boolean) {
  const [statuses, setStatuses] = useState<Record<string, JobStatus>>({});
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!enabled || !jobIds.length) return;

    const poll = async () => {
      const updates = await Promise.allSettled(
        jobIds.map(async (jobId) => {
          const res = await fetch(`/api/jobs/${jobId}/status`);
          const data: JobStatus = await res.json();
          return { jobId, data };
        })
      );

      setStatuses((prev) => {
        const next = { ...prev };
        for (const result of updates) {
          if (result.status === "fulfilled") {
            next[result.value.jobId] = result.value.data;
          }
        }
        return next;
      });

      // Stop polling if all jobs are terminal
      const allDone = jobIds.every((id) => {
        const s = statuses[id]?.status;
        return s === "completed" || s === "failed";
      });
      if (allDone && intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };

    poll();
    intervalRef.current = setInterval(poll, 10000);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [jobIds, enabled]);

  return statuses;
}
