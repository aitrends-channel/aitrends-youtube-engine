import { OneClickProgress } from "@/components/one-click/OneClickProgress";
import { WizardNav } from "@/components/wizard/WizardNav";

interface PageProps { params: { projectId: string } }

// Live "watch it run" view for a 1Click project — the kickoff redirects
// here, and the dashboard's running badge links here. The orchestrator
// advances the project server-side; this page reflects it and nudges
// the tick while open.
export default function OneClickProgressPage({ params }: PageProps) {
  const { projectId } = params;
  return (
    <div className="flex h-screen overflow-x-hidden">
      <WizardNav projectId={projectId} currentState={1} />
      <main className="flex-1 min-w-0 overflow-y-auto pt-[105px] md:pt-0">
        <OneClickProgress projectId={projectId} />
      </main>
    </div>
  );
}
