"use client";

import { useProject } from "@/hooks/useProject";
import { NextVideoPanel } from "@/components/NextVideoPanel";
import { DashboardHeader } from "@/components/DashboardHeader";

interface PageProps {
  params: { projectId: string };
}

export default function NextVideoLandingPage({ params }: PageProps) {
  const { projectId } = params;
  const { project } = useProject(projectId);

  return (
    <div className="min-h-screen flex flex-col overflow-x-hidden" style={{ background: "var(--bg-page)" }}>
      <DashboardHeader />

      <main className="flex-1 flex flex-col items-center justify-center px-4 sm:px-8 py-16">
        <div className="w-full max-w-3xl space-y-8">
          <div className="text-center space-y-3">
            <div className="w-16 h-16 mx-auto rounded-2xl flex items-center justify-center"
              style={{ background: "oklch(0.55 0.15 145 / 0.12)", border: "1px solid oklch(0.55 0.15 145 / 0.3)" }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="oklch(0.55 0.15 145)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold">All set</h1>
            <p className="text-sm" style={{ color: "var(--c-55)" }}>
              {project?.channel_name
                ? <>Your video for <span style={{ color: "var(--c-90)", fontWeight: 600 }}>{project.channel_name}</span> is ready.</>
                : "Your video is ready."}
            </p>
          </div>

          <NextVideoPanel projectId={projectId} project={project} />
        </div>
      </main>
    </div>
  );
}
