"use client";

import { useState } from "react";
import Image from "next/image";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);

  const inputStyle = {
    background: "var(--bg-input)",
    border: "1px solid var(--bd-10)",
    color: "var(--c-90)",
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("http://localhost:3001/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send reset email");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4"
      style={{ background: "var(--bg-page)" }}
    >
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8 space-y-3">
          <div className="w-14 h-14 rounded-full overflow-hidden">
            <Image src="/logo.png" alt="aiTrends" width={56} height={56} className="object-cover w-full h-full" />
          </div>
          <div className="text-center">
            <p className="font-bold text-lg tracking-tight">aiTrends</p>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>YT Workflow</p>
          </div>
        </div>

        <div
          className="rounded-2xl p-6"
          style={{ background: "var(--bg-card)", border: "1px solid oklch(1 0 0 / 0.08)" }}
        >
          <h1 className="text-sm font-semibold mb-1" style={{ color: "var(--c-75)" }}>
            Reset your password
          </h1>

          {sent ? (
            <div className="space-y-3 pt-2">
              <p className="text-xs" style={{ color: "var(--c-50)" }}>
                Check your inbox — we sent a reset link to{" "}
                <span style={{ color: "var(--c-70)" }}>{email}</span>.
              </p>
              <p className="text-xs" style={{ color: "var(--c-40)" }}>
                Didn&apos;t get it? Check your spam folder or{" "}
                <button
                  onClick={() => setSent(false)}
                  className="hover:underline transition-colors"
                  style={{ color: "var(--c-55)" }}
                >
                  try again
                </button>
                .
              </p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4 mt-4">
              <div className="space-y-2">
                <label className="text-xs font-medium" style={{ color: "var(--c-50)" }}>
                  Email
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  placeholder="you@example.com"
                  className="w-full px-3 py-2.5 rounded-lg text-sm outline-none transition-all"
                  style={inputStyle}
                  onFocus={(e) => { e.currentTarget.style.borderColor = "oklch(0.72 0.25 285 / 0.5)"; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-10)"; }}
                />
              </div>

              {error && (
                <p
                  className="text-xs px-3 py-2 rounded-lg"
                  style={{
                    background: "oklch(0.6 0.22 25 / 0.1)",
                    color: "oklch(0.7 0.2 25)",
                    border: "1px solid oklch(0.6 0.22 25 / 0.2)",
                  }}
                >
                  {error}
                </p>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2.5 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
                style={{ background: "oklch(0.72 0.25 285)", color: "oklch(0.08 0 0)" }}
              >
                {loading ? "…" : "Send reset link"}
              </button>

              <p className="text-center text-xs" style={{ color: "var(--c-40)" }}>
                Remember it?{" "}
                <a href="/login" className="transition-colors hover:underline" style={{ color: "var(--c-55)" }}>
                  Back to sign in
                </a>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
