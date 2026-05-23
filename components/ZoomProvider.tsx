"use client";

import { useEffect } from "react";
import { useIconThemeStore } from "@/store/iconThemeStore";

export function ZoomProvider() {
  const zoom = useIconThemeStore((s) => s.zoom);
  useEffect(() => {
    // Never touch style.zoom on touch devices — even setting it to "" triggers iOS Safari
    // to recalculate viewport scale, which causes the page to jump/zoom unexpectedly.
    const isTouch = navigator.maxTouchPoints > 0 || "ontouchstart" in window;
    if (isTouch) return;

    function apply() {
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
