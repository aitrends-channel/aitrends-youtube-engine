import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ThemeId } from "@/lib/iconThemes";

const ZOOM_STEPS = [80, 85, 90, 95, 100, 105, 110, 115, 125] as const;

interface IconThemeState {
  themeId: ThemeId;
  zoom: number;
  setTheme: (id: ThemeId) => void;
  setZoom: (zoom: number) => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

export const useIconThemeStore = create<IconThemeState>()(
  persist(
    (set, get) => ({
      themeId: "geometric",
      zoom: 100,
      setTheme: (id) => set({ themeId: id }),
      setZoom: (zoom) => set({ zoom }),
      zoomIn: () => {
        const current = get().zoom;
        const idx = ZOOM_STEPS.indexOf(current as typeof ZOOM_STEPS[number]);
        const next = idx === -1 ? 105 : ZOOM_STEPS[Math.min(idx + 1, ZOOM_STEPS.length - 1)];
        set({ zoom: next });
      },
      zoomOut: () => {
        const current = get().zoom;
        const idx = ZOOM_STEPS.indexOf(current as typeof ZOOM_STEPS[number]);
        const next = idx === -1 ? 95 : ZOOM_STEPS[Math.max(idx - 1, 0)];
        set({ zoom: next });
      },
    }),
    { name: "yt-engine-icon-theme" }
  )
);
