import { NextResponse } from "next/server";
import type { Operator } from "./index";
import { OPERATOR_POYO } from "./index";

// Turning a provider failure into an HTTP response, once, for every operator.
//
// KieUpstreamError and PoyoUpstreamError carry the same four fields and want
// the same status mapping, so the branch that used to live inline in
// images/submit is here instead. Duplicating it per provider is how the two
// drift into disagreeing about whether a 429 is a 429.
//
// One thing genuinely differs and it is not cosmetic: whose money ran out. A
// KIE 402 on a BYO client is the customer's balance and the customer can fix
// it. A PoYo 402 is always Heclus's balance, because PoYo runs on Heclus's key
// with no per-client path, so telling that customer to top up would send them
// to an account they do not have.

export interface UpstreamError {
  upstreamStatus: number;
  retryAfter: number | null;
  message: string;
  insufficientCredits: boolean;
}

/** Structural, not instanceof: the two error classes live in provider modules
 *  that this one must not import, or the operator layer depends on every
 *  provider it is meant to abstract. */
export function asUpstreamError(err: unknown): UpstreamError | null {
  if (!(err instanceof Error)) return null;
  const e = err as Error & Partial<UpstreamError>;
  if (typeof e.upstreamStatus !== "number") return null;
  return {
    upstreamStatus: e.upstreamStatus,
    retryAfter: typeof e.retryAfter === "number" ? e.retryAfter : null,
    message: e.message,
    insufficientCredits: e.insufficientCredits === true,
  };
}

/**
 * Both providers' ways of saying "slow down": a 429 status, or the sentence
 * KIE puts in a 200 body ("Your call frequency is too high").
 *
 * Returns the seconds to wait, or null when the error is something else.
 * The provider's own Retry-After wins when it sent one, capped so a long
 * advisory cannot hold a request open past its function timeout.
 */
const RATE_LIMITED = /\b429\b|rate limit|too many requests|call frequency/i;

export function rateLimitDelaySeconds(err: unknown, attempt: number): number | null {
  const upstream = asUpstreamError(err);
  const limited = upstream
    ? upstream.upstreamStatus === 429
    : err instanceof Error && RATE_LIMITED.test(err.message);
  if (!limited) return null;

  const advised = upstream?.retryAfter;
  if (advised != null && advised > 0) return Math.min(advised, 20);
  return Math.min(8, 2 ** attempt);
}

/**
 * Retry a provider call while it is being rate limited.
 *
 * A 429 is the one upstream failure that is certain to pass on its own, and
 * without this it failed the beat outright: the user saw "Too many requests"
 * on work that only needed a second. The 1Click orchestrator has always
 * retried these; the manual routes did not, which is why the same run
 * succeeded from 1Click and failed from the Generate button.
 *
 * Three retries by default: 1s, 2s, 4s. That fits inside the 120s the image
 * routes declare even with a full batch in flight, and a limit that outlasts
 * 7s is one the caller should surface rather than sit on.
 */
export async function withRateLimitRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const wait = attempt < attempts ? rateLimitDelaySeconds(err, attempt) : null;
      if (wait === null) throw err;
      // Jitter so a batch that was rate limited together does not retry in
      // lockstep and trip the same limit again.
      await new Promise((r) => setTimeout(r, wait * 1000 + Math.random() * 300));
    }
  }
}

export function upstreamErrorResponse(err: UpstreamError, operator: Operator): NextResponse {
  const headers: Record<string, string> = {};
  if (err.upstreamStatus === 429 && err.retryAfter != null) {
    headers["Retry-After"] = String(err.retryAfter);
  }

  // 402 for an empty wallet so it does not page as a server fault, 429 stays
  // 429 for the client's retry logic, everything else is a bad gateway: our
  // request was valid and the provider failed it.
  let status = 502;
  let code: string | undefined;
  if (err.insufficientCredits) {
    status = 402;
    code = "insufficient_credits";
  } else if (err.upstreamStatus === 429) {
    status = 429;
  }

  let error = err.message;
  if (err.insufficientCredits) {
    error = operator === OPERATOR_POYO
      ? "Heclus's image provider account is out of credit. This is on our side, not yours — it is being topped up."
      : "Your KIE account is out of credits. Add credits at kie.ai and try again.";
  }

  return NextResponse.json({ error, code, upstreamStatus: err.upstreamStatus }, { status, headers });
}
