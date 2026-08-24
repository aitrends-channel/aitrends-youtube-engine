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
  /** What the run was estimated to cost, when it was refused before starting
   *  rather than after running out. Turns "out of credits" into "not enough
   *  for this run", which are different things to a user with credits left. */
  needed: number | null;
  /** A model the balance can afford for the same run, when there is one. */
  alternative: { name: string; total: number } | null;
  /** The model the user actually chose, and how many generations were asked
   *  for. Named in the modal because a suggestion beside no subject reads as a
   *  statement about the current selection. */
  modelName: string | null;
  count: number | null;
  show: (opts?: {
    message?: string | null;
    credits?: number | null;
    needed?: number | null;
    alternative?: { name: string; total: number } | null;
    modelName?: string | null;
    count?: number | null;
  }) => void;
  hide: () => void;
}

export const useOutOfCreditsStore = create<OutOfCreditsState>()((set) => ({
  open: false,
  message: OUT_OF_CREDITS_MESSAGE,
  credits: null,
  needed: null,
  alternative: null,
  modelName: null,
  count: null,
  show: (opts) =>
    set({
      open: true,
      message: opts?.message?.trim() || OUT_OF_CREDITS_MESSAGE,
      credits: typeof opts?.credits === "number" ? opts.credits : null,
      needed: typeof opts?.needed === "number" ? opts.needed : null,
      alternative: opts?.alternative ?? null,
      modelName: opts?.modelName ?? null,
      count: typeof opts?.count === "number" ? opts.count : null,
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

/**
 * Refuse a run the balance cannot cover, before it starts.
 *
 * Returns true when the run was refused, so the caller can stop in the same
 * expression. A model with no known rate reports sufficient and is allowed
 * through: an unpriceable run must not be blocked on a made-up number.
 */
export function blockIfShort(
  estimate: {
    sufficient: boolean;
    total: number | null;
    balance: number;
    alternative?: { name: string; total: number } | null;
  },
  /** What the user chose, so the modal can say whose 276 credits these are. */
  run?: { modelName?: string | null; count?: number | null },
): boolean {
  if (estimate.sufficient || estimate.total === null) return false;
  useOutOfCreditsStore.getState().show({
    credits: estimate.balance,
    needed: estimate.total,
    alternative: estimate.alternative ?? null,
    modelName: run?.modelName ?? null,
    count: run?.count ?? null,
  });
  return true;
}
