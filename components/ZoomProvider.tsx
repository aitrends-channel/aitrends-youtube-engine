"use client";

import { useEffect } from "react";
import { useIconThemeStore } from "@/store/iconThemeStore";

export function ZoomProvider() {
  const zoom = useIconThemeStore((s) => s.zoom);
  useEffect(() => {
    function apply() {
      // Zoom control is a desktop-only feature; never shrink mobile viewports
      document.documentElement.style.zoom = window.innerWidth >= 768 ? `${zoom / 100}` : "";
    }
    apply();
    window.addEventListener("resize", apply);
    return () => {
      window.removeEventListener("resize", apply);
      document.documentElement.style.zoom = "";
    };
  }, [zoom]);
  return null;
}
