import { create } from "zustand";
import { OUT_OF_CREDITS_MESSAGE, isOutOfCreditsMessage } from "@/lib/out-of-credits";

// One place that knows the wallet is empty, so every surface can raise the
// same modal instead of growing its own red banner.
//
// A store rather than per-page state because the refusal arrives from anywhere:
// a 402 on a submit, a per-beat failure inside an otherwise successful batch, a
// stream event. OutOfCreditsGate mounts the modal once in Providers and this is
// how the rest of the app reaches it.

interface OutOfCreditsState {
  open: boolean;
  /** The server's own wording when it sent one, else the shared refusal. */
  message: string;
  /** Balance at the moment of refusal, when the response reported it. */
  credits: number | null;
  show: (opts?: { message?: string | null; credits?: number | null }) => void;
  hide: () => void;
}

export const useOutOfCreditsStore = create<OutOfCreditsState>()((set) => ({
  open: false,
  message: OUT_OF_CREDITS_MESSAGE,
  credits: null,
  show: (opts) =>
    set({
      open: true,
      message: opts?.message?.trim() || OUT_OF_CREDITS_MESSAGE,
      credits: typeof opts?.credits === "number" ? opts.credits : null,
    }),
  hide: () => set({ open: false }),
}));

/**
 * Raise the modal if this text is the empty-wallet refusal.
 *
 * Returns whether it matched, so the caller can skip its inline banner in the
 * same expression: the modal is the whole notification now, and showing both
 * says the same thing twice.
 */
export function reportOutOfCredits(text: string | null | undefined): boolean {
  if (!isOutOfCreditsMessage(text)) return false;
  useOutOfCreditsStore.getState().show({ message: text });
  return true;
}
