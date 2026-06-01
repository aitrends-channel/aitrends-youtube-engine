// Retry helper for upstream KIE transients. KIE intermittently returns
// 500 "Server exception, please try again later", 429 rate-limit, and
// network errors that clear within seconds. Retries with exponential
// backoff (1s, 2s, 4s by default). Auth/validation (4xx) errors fail
// fast — retrying won't help there.
export async function retryClaudeCall<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 3
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const status =
        (err as { status?: number })?.status ??
        (err as { response?: { status?: number } })?.response?.status;
      const isTransient = !status || (status >= 500 && status < 600) || status === 429;
      if (!isTransient || i === attempts - 1) throw err;
      const delayMs = 1000 * Math.pow(2, i); // 1s, 2s, 4s
      console.warn(`[claude-retry] ${label} attempt ${i + 1}/${attempts} failed (status=${status ?? "network"}); retrying in ${delayMs}ms`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
