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
