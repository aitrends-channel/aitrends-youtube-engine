import { DemoProvider } from "@/lib/demo-context";
import { DemoTopBar } from "@/components/demo/DemoTopBar";

export default function DemoLayout({ children }: { children: React.ReactNode }) {
  return (
    <DemoProvider>
      <div className="flex flex-col h-screen">
        <DemoTopBar />
        <div className="flex flex-1 min-h-0">
          {children}
        </div>
      </div>
    </DemoProvider>
  );
}
