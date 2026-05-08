"use client";

import { useEffect } from "react";
import { useIconThemeStore } from "@/store/iconThemeStore";

export function ZoomProvider() {
  const zoom = useIconThemeStore((s) => s.zoom);
  useEffect(() => {
    document.documentElement.style.zoom = `${zoom / 100}`;
    return () => { document.documentElement.style.zoom = ""; };
  }, [zoom]);
  return null;
}
