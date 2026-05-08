"use client";

import { createContext, useContext, useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";

type Theme = "dark" | "light";

interface ThemeCtxValue {
  resolvedTheme: Theme;
  setTheme: (t: Theme) => void;
}

const ThemeCtx = createContext<ThemeCtxValue>({ resolvedTheme: "dark", setTheme: () => {} });

export function useTheme() {
  return useContext(ThemeCtx);
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [theme, setThemeState] = useState<Theme>("dark");

  useEffect(() => {
    const stored = localStorage.getItem("theme");
    const initial: Theme = stored === "light" ? "light" : "dark";
    setThemeState(initial);
    document.documentElement.setAttribute("data-theme", initial);
  }, []);

  function setTheme(t: Theme) {
    setThemeState(t);
    localStorage.setItem("theme", t);
    document.documentElement.setAttribute("data-theme", t);
  }

  return (
    <ThemeCtx.Provider value={{ resolvedTheme: theme, setTheme }}>
      {children}
      <Toaster position="bottom-right" theme={theme} />
    </ThemeCtx.Provider>
  );
}
