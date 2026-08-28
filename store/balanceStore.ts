import { create } from "zustand";

// "Something just got charged — read the balance again."
//
// The balance chip used to infer this. It polled while a step registered
// activity and stopped when the step released it, so the number on screen was
// whatever the last tick happened to catch: up to a poll interval stale during
// a run, and frozen afterwards until the tab was switched.
//
// Polling cannot be made exact by shortening it, only more expensive. The page
// already knows the moment a beat lands, so this is that moment travelling to
// the chip: any surface bumps the counter, and every balance reader revalidates.
//
// Deliberately a counter rather than a boolean or a payload. The chip does not
// need to know what finished or how much it cost; it needs to know that what it
// is displaying is now out of date, and a monotonic number says exactly that
// without two callers in the same tick cancelling each other out.

interface BalanceState {
  /** Increments whenever work completes that may have moved the balance. */
  version: number;
  /** Call after a generation lands. Cheap, idempotent, safe to over-call. */
  refreshBalance: () => void;
}

export const useBalanceStore = create<BalanceState>()((set) => ({
  version: 0,
  refreshBalance: () => set((s) => ({ version: s.version + 1 })),
}));

/** For callers outside React — a poll callback, a stream handler. */
export function refreshBalance(): void {
  useBalanceStore.getState().refreshBalance();
}
