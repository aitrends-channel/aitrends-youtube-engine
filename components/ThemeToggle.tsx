"use client";

import { useTheme } from "@/components/Providers";
import { Sun, Moon } from "lucide-react";

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  return (
    <button
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
      className="flex items-center justify-center w-9 h-9 rounded-lg transition-all hover:opacity-80 cursor-pointer"
      style={{ background: "var(--bg-control)", color: "var(--c-55)", border: "1px solid var(--bd-8)" }}
      aria-label="Toggle theme"
    >
      {resolvedTheme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}
