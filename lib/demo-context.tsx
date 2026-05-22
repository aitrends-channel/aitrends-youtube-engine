"use client";

import { createContext, useContext, useState } from "react";

export interface DemoState {
  // Navigation
  highestStep: number;

  // Channel
  channelPhase: "idle" | "loading" | "done";
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

  // Thumbnails
  conceptPhase: "idle" | "running" | "done";
  thumbImagePhase: "idle" | "running" | "done";
  thumbImageProgress: number;
  selectedThumbModel: string;
  selectedThumbRatio: string;
}

const DEFAULTS: DemoState = {
  highestStep: 0,
  channelPhase: "idle",
  channelTopicMode: "generate",
  channelTopicHint: "",
  selectedTopic: "",
  scriptPhase: "loading",
  visualsFetchPhase: "idle",
  visualsAnalyzePhase: "idle",
  promptsTab: "image",
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
  conceptPhase: "idle",
  thumbImagePhase: "idle",
  thumbImageProgress: 0,
  selectedThumbModel: "i1",
  selectedThumbRatio: "16:9",
};

interface DemoContextValue {
  state: DemoState;
  update: (patch: Partial<DemoState>) => void;
}

const DemoContext = createContext<DemoContextValue | null>(null);

export function DemoProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DemoState>(DEFAULTS);
  const update = (patch: Partial<DemoState>) =>
    setState((prev) => ({ ...prev, ...patch }));
  return (
    <DemoContext.Provider value={{ state, update }}>
      {children}
    </DemoContext.Provider>
  );
}

export function useDemoState() {
  const ctx = useContext(DemoContext);
  if (!ctx) throw new Error("useDemoState must be used within DemoProvider");
  return ctx;
}
