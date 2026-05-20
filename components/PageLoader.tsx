"use client";

import Image from "next/image";

export function PageLoader() {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "var(--bg-page, oklch(0.07 0.004 280))" }}
    >
      <div className="flex flex-col items-center gap-4">
        <div
          style={{
            animation: "heclus-pulse 1.6s ease-in-out infinite",
          }}
        >
          <Image
            src="/heclus-icon-white.svg"
            alt="Heclus"
            width={52}
            height={52}
            className="rounded-xl"
          />
        </div>
        <div className="flex gap-1.5">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="w-1.5 h-1.5 rounded-full"
              style={{
                background: "oklch(0.72 0.25 285)",
                animation: `heclus-dot 1.2s ease-in-out ${i * 0.2}s infinite`,
              }}
            />
          ))}
        </div>
      </div>

      <style>{`
        @keyframes heclus-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50%       { opacity: 0.6; transform: scale(0.92); }
        }
        @keyframes heclus-dot {
          0%, 80%, 100% { opacity: 0.25; transform: scale(0.8); }
          40%            { opacity: 1;    transform: scale(1); }
        }
      `}</style>
    </div>
  );
}
