import { create } from "zustand";
import { OUT_OF_CREDITS_MESSAGE, isOutOfCreditsMessage } from "@/lib/out-of-credits";

// One place that knows the wallet is empty, so every surface can raise the
// same modal instead of growing its own red banner.
//
// A store rather than per-page state because the refusal arrives from anywhere:
// a 402 on a submit, a per-beat failure inside an otherwise successful batch, a
// stream event. OutOfCreditsGate mounts the modal once in Providers and this is
// how the rest of the app reaches it.

/**
 * What the user did with the refusal.
 *
 * A number runs that many generations, null abandons the run, and "switch"
 * asks the caller to change to the affordable model and price it again — which
 * reopens this modal with the new figures rather than resolving.
 */
export type Decision = number | null | "switch";

interface OutOfCreditsState {
  open: boolean;
  /** "short" is the refusal. "ready" is the same modal after a switch, showing
   *  the model the user moved to and what it will cost, so pressing Switch
   *  never silently starts a run they did not ask to start. */
  kind: "short" | "ready";
  /** The server's own wording when it sent one, else the shared refusal. */
  message: string;
  /** Balance at the moment of refusal, when the response reported it. */
  credits: number | null;
  /** What the run was estimated to cost, when it was refused before starting
   *  rather than after running out. Turns "out of credits" into "not enough
   *  for this run", which are different things to a user with credits left. */
  needed: number | null;
  /** A model the balance can afford for the same run, when there is one. The
   *  id is carried so the modal can switch to it rather than only name it. */
  alternative: { modelId: string; name: string; total: number } | null;
  /** The model the user actually chose, and how many generations were asked
   *  for. Named in the modal because a suggestion beside no subject reads as a
   *  statement about the current selection. */
  modelName: string | null;
  count: number | null;
  /** How many of the asked-for generations the balance does cover. The modal
   *  offers to run those instead of refusing the lot, which is what a user
   *  with 444 credits and a 570-credit run actually wants. */
  affordable: number | null;
  /** Settles the caller's await. Held here because the decision is the user's
   *  and arrives long after the call that raised the modal. */
  resolve: ((d: Decision) => void) | null;
  show: (opts?: {
    message?: string | null;
    credits?: number | null;
    needed?: number | null;
    alternative?: { modelId: string; name: string; total: number } | null;
    modelName?: string | null;
    count?: number | null;
    affordable?: number | null;
    resolve?: ((d: Decision) => void) | null;
  }) => void;
  /** Close, answering the waiting caller. Every path out of the modal goes
   *  through here so an await can never dangle. */
  choose: (d: Decision) => void;
  hide: () => void;
}

export const useOutOfCreditsStore = create<OutOfCreditsState>()((set) => ({
  open: false,
  kind: "short",
  message: OUT_OF_CREDITS_MESSAGE,
  credits: null,
  needed: null,
  alternative: null,
  modelName: null,
  count: null,
  affordable: null,
  resolve: null,
  show: (opts) =>
    set((prev) => {
      // A second refusal while one is already waiting: answer the first rather
      // than leaving its caller awaiting forever.
      prev.resolve?.(null);
      return {
        open: true,
        kind: "short" as const,
        message: opts?.message?.trim() || OUT_OF_CREDITS_MESSAGE,
        credits: typeof opts?.credits === "number" ? opts.credits : null,
        needed: typeof opts?.needed === "number" ? opts.needed : null,
        alternative: opts?.alternative ?? null,
        modelName: opts?.modelName ?? null,
        count: typeof opts?.count === "number" ? opts.count : null,
        affordable: typeof opts?.affordable === "number" ? opts.affordable : null,
        resolve: opts?.resolve ?? null,
      };
    }),
  choose: (n) =>
    set((prev) => {
      prev.resolve?.(n);
      return { open: false, resolve: null };
    }),
  hide: () =>
    set((prev) => {
      prev.resolve?.(null);
      return { open: false, resolve: null };
    }),
}));

/**
 * Show what the switched-to model will do, and wait for the user to confirm.
 *
 * Pressing "Switch to X" answers a question about price; it is not a decision
 * to spend. So the modal stays up with the new figures and the run starts only
 * when the user presses Generate.
 */
export function confirmSwitch(opts: {
  modelName: string;
  count: number;
  total: number | null;
  balance: number;
}): Promise<Decision> {
  return new Promise<Decision>((resolve) => {
    useOutOfCreditsStore.setState((prev) => {
      prev.resolve?.(null);
      return {
        open: true,
        kind: "ready" as const,
        message: OUT_OF_CREDITS_MESSAGE,
        credits: opts.balance,
        needed: opts.total,
        alternative: null,
        modelName: opts.modelName,
        count: opts.count,
        affordable: opts.count,
        resolve,
      };
    });
  });
}

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
    alternative?: { modelId: string; name: string; total: number } | null;
    affordableCount?: number | null;
  },
  /** What the user chose, so the modal can say whose 276 credits these are. */
  run?: { modelName?: string | null; count?: number | null },
  opts?: {
    /** Show even though the run is allowed to start. An image run is gated on
     *  its first batch and stops itself when the wallet empties, so it is not
     *  refused — but the user should still be told it will get through 148 of
     *  216 rather than finding out when it stops. */
    informational?: boolean;
  },
): Promise<Decision> {
  // Resolves to how many generations may go ahead, or null to abandon the run.
  // A run the balance covers resolves immediately with everything asked for; it
  // is only a shortfall that waits on the user.
  if ((estimate.sufficient && !opts?.informational) || estimate.total === null) {
    return Promise.resolve(run?.count ?? null);
  }
  return new Promise<Decision>((resolve) => {
    useOutOfCreditsStore.getState().show({
      credits: estimate.balance,
      needed: estimate.total,
      alternative: estimate.alternative ?? null,
      modelName: run?.modelName ?? null,
      count: run?.count ?? null,
      affordable: typeof estimate.affordableCount === "number" ? estimate.affordableCount : null,
      resolve,
    });
  });
}
