"use client";

import { createContext, useContext, useState, useEffect } from "react";

export interface DemoState {
  // Navigation
  highestStep: number;

  // Channel
  channelPhase: "idle" | "loading" | "done";
  channelContentType: "long" | "shorts" | "both" | null;
  channelTopicMode: "generate" | "custom";
  channelTopicHint: string;

  // Topic
  selectedTopic: string;

  // Script
  scriptPhase: "loading" | "done";

  // Visuals
  visualsFetchPhase: "idle" | "fetching" | "done";
  visualsAnalyzePhase: "idle" | "running" | "done";

  // Prompts
  promptsTab: "image" | "video";
  promptsPhase: "idle" | "generating" | "done";

  // Generate — Voiceover
  selectedVoice: string;
  ttsPhase: "idle" | "generating" | "done";

  // Generate — Images
  selectedImageModel: string;
  selectedImageRatio: string;
  imagesPhase: "idle" | "generating" | "done";
  imagesProgress: number;

  // Generate — Videos
  selectedVideoModel: string;
  selectedVideoRatio: string;
  selectedDuration: number;
  videosPhase: "idle" | "queuing" | "done";

  // Assemble
  aspectRatio: "16:9" | "9:16" | "1:1";
  voiceoverType: "original" | "trimmed";
  captionsEnabled: boolean;
  captionsStyle: string;
  captionsSize: string;
  captionsPosition: string;
  captionsLanguage: string;
  assemblePhase: "idle" | "assembling" | "done";
  // Background music + logo. Stored as data URLs so they survive a
  // navigate-away-and-back round trip (sessionStorage is the demo
  // context's persistence layer; blob: URLs created from File objects
  // die with the page). For typical small uploads (<1-2 MB) this fits
  // comfortably in sessionStorage. If a user picks something huge and
  // the save fails the state still works in-memory for the current
  // session — they just lose persistence on a hard reload.
  bgmName: string | null;
  bgmSizeMb: number | null;
  bgmDataUrl: string | null;
  bgmVolume: number;
  logoName: string | null;
  logoSizeKb: number | null;
  logoDataUrl: string | null;
  logoSize: number;  // 0-1 fraction of canvas width
  logoX: number;     // 0-1 fraction
  logoY: number;     // 0-1 fraction

  // Thumbnails
  conceptPhase: "idle" | "running" | "done";
  thumbImagePhase: "idle" | "running" | "done";
  thumbImageProgress: number;
  thumbOffset: number;
  selectedThumbModel: string;
  selectedThumbRatio: string;
}

const DEFAULTS: DemoState = {
  highestStep: 0,
  channelPhase: "idle",
  channelContentType: null,
  channelTopicMode: "generate",
  channelTopicHint: "",
  selectedTopic: "",
  scriptPhase: "loading",
  visualsFetchPhase: "idle",
  visualsAnalyzePhase: "idle",
  promptsTab: "image",
  promptsPhase: "idle",
  selectedVoice: "TX3LPaxmHKxFdv7VOQHJ",
  ttsPhase: "idle",
  selectedImageModel: "i1",
  selectedImageRatio: "16:9",
  imagesPhase: "idle",
  imagesProgress: 0,
  selectedVideoModel: "vd1",
  selectedVideoRatio: "16:9",
  selectedDuration: 5,
  videosPhase: "idle",
  aspectRatio: "16:9",
  voiceoverType: "original",
  captionsEnabled: false,
  captionsStyle: "classic",
  captionsSize: "medium",
  captionsPosition: "bottom",
  captionsLanguage: "source",
  assemblePhase: "idle",
  bgmName: null,
  bgmSizeMb: null,
  bgmDataUrl: null,
  bgmVolume: 0.25,
  logoName: null,
  logoSizeKb: null,
  logoDataUrl: null,
  logoSize: 0.1,
  logoX: 0.85,
  logoY: 0.05,
  conceptPhase: "idle",
  thumbImagePhase: "idle",
  thumbImageProgress: 0,
  thumbOffset: 0,
  selectedThumbModel: "i1",
  selectedThumbRatio: "16:9",
};

const SESSION_KEY = "demo_state_v1";

// Phases that should not be considered "in-progress" on restore —
// snap them back to a stable state so the UI never shows a spinner on load.
const PHASE_RESETS: Partial<DemoState> = {
  assemblePhase:       "idle",
  thumbImagePhase:     "idle",
  imagesPhase:         "idle",
  videosPhase:         "idle",
  ttsPhase:            "idle",
  visualsFetchPhase:   "idle",
  visualsAnalyzePhase: "idle",
  promptsPhase:        "idle",
  conceptPhase:        "idle",
};

function sanitize(s: DemoState): DemoState {
  const out = { ...s };
  for (const [key, idleVal] of Object.entries(PHASE_RESETS) as [keyof DemoState, string][]) {
    if ((out[key] as string) !== "done") {
      (out as Record<string, unknown>)[key] = idleVal;
    }
  }
  if (out.channelPhase === ("loading" as string)) out.channelPhase = "idle";
  // Defend against a stale sessionStorage row holding a value outside
  // the new enum (e.g. an older build's "" placeholder).
  if (out.channelContentType !== null
      && out.channelContentType !== "long"
      && out.channelContentType !== "shorts"
      && out.channelContentType !== "both") {
    out.channelContentType = null;
  }
  return out;
}

function loadFromSession(): DemoState {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return DEFAULTS;
    return sanitize({ ...DEFAULTS, ...JSON.parse(raw) });
  } catch {
    return DEFAULTS;
  }
}

interface DemoContextValue {
  state: DemoState;
  update: (patch: Partial<DemoState>) => void;
  resetDemo: () => void;
  // Transient UI state (not persisted to sessionStorage)
  currentStep: number;          // -1 when not on a workflow page (e.g. dashboard)
  setCurrentStep: (step: number) => void;
  drawerOpen: boolean;
  setDrawerOpen: (open: boolean) => void;
  drawerHighlightStep: number;  // which circle was tapped to open the drawer (-1 = none)
  setDrawerHighlightStep: (step: number) => void;
}

const DemoContext = createContext<DemoContextValue | null>(null);

export function DemoProvider({ children }: { children: React.ReactNode }) {
  // Read sessionStorage synchronously so child pages' useState initializers
  // already see the restored state on the very first client render.
  const [state, setState] = useState<DemoState>(() => {
    if (typeof window === "undefined") return DEFAULTS;
    return loadFromSession();
  });

  const [currentStep, setCurrentStep] = useState(-1);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerHighlightStep, setDrawerHighlightStep] = useState(-1);

  // Persist to sessionStorage on every state change
  useEffect(() => {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(state));
    } catch {
      // ignore (private browsing / storage full)
    }
  }, [state]);

  const update = (patch: Partial<DemoState>) =>
    setState((prev) => ({ ...prev, ...patch }));

  const resetDemo = () => {
    try { sessionStorage.removeItem(SESSION_KEY); } catch {}
    setState(DEFAULTS);
  };

  return (
    <DemoContext.Provider value={{ state, update, resetDemo, currentStep, setCurrentStep, drawerOpen, setDrawerOpen, drawerHighlightStep, setDrawerHighlightStep }}>
      {children}
    </DemoContext.Provider>
  );
}

export function useDemoState() {
  const ctx = useContext(DemoContext);
  if (!ctx) throw new Error("useDemoState must be used within DemoProvider");
  return ctx;
}
