"use client";

import useSWR from "swr";

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) return r.json().catch(() => ({})).then((e: { error?: string }) => { throw new Error(e.error ?? `Request failed (${r.status})`); });
    return r.json().catch(() => ({}));
  });

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
