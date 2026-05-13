"use client";

import useSWR from "swr";

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function useProject(projectId: string | null) {
  const { data, error, isLoading, mutate } = useSWR(
    projectId ? `/api/projects/${projectId}` : null,
    fetcher,
    { refreshInterval: 5000 }
  );

  return {
    project: data,
    isLoading,
    isError: error,
    mutate,
  };
}
