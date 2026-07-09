import { create } from "zustand";

// Cross-page signal for "is there any active KIE-consuming work in this
// tab". Steps register themselves under a unique key while they're
// doing work; balance / api-status pollers subscribe to hasActivity
// and use it to gate their SWR refreshInterval. When the store is
// empty the pollers stop hitting KIE entirely.
//
// The key is caller-defined (typically the step name, e.g. "generate",
// "voiceover"). Multiple activities can be registered simultaneously —
// hasActivity stays true until every caller has released its key. That
// keeps the balance polling live across e.g. "user is regenerating
// images AND queuing video clips at the same time".

interface KieActivityState {
  activeKeys: Set<string>;
  hasActivity: boolean;
  markActive: (key: string) => void;
  markIdle: (key: string) => void;
}

export const useKieActivityStore = create<KieActivityState>()((set, get) => ({
  activeKeys: new Set<string>(),
  hasActivity: false,
  markActive: (key) => {
    const next = new Set(get().activeKeys);
    if (next.has(key)) return;
    next.add(key);
    set({ activeKeys: next, hasActivity: next.size > 0 });
  },
  markIdle: (key) => {
    const current = get().activeKeys;
    if (!current.has(key)) return;
    const next = new Set(current);
    next.delete(key);
    set({ activeKeys: next, hasActivity: next.size > 0 });
  },
}));
