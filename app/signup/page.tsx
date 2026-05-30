"use client";

import { useState, useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { Spinner } from "@/components/ui/spinner";
import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";

function SignupForm({ onSuccess }: { onSuccess: (email: string) => void }) {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ first_name: firstName, last_name: lastName, email }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? data?.message ?? `Request failed (${res.status})`);
      }
      onSuccess(email);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Signup failed";
      const lower = msg.toLowerCase();
      setError(
        msg === "Failed to fetch" || lower.includes("network") || lower.includes("failed to fetch")
          ? "Unable to reach the server. Check your connection and try again."
          : lower.includes("already registered") || lower.includes("already been registered") || lower.includes("already exists") || lower.includes("email already")
          ? "An account with this email already exists. Try signing in instead."
          : lower.includes("invalid email")
          ? "Please enter a valid email address."
          : lower.includes("rate limit") || lower.includes("too many")
          ? "Too many sign-up attempts. Please wait a few minutes and try again."
          : msg
      );
    } finally {
      setLoading(false);
    }
  }

  const inputStyle = {
    background: "var(--bg-input)",
    border: "1px solid var(--bd-10)",
    color: "var(--c-90)",
  };

  const focusOn = (e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.style.borderColor = "oklch(0.72 0.25 285 / 0.5)";
  };
  const focusOff = (e: React.FocusEvent<HTMLInputElement>) => {
    e.currentTarget.style.borderColor = "var(--bd-10)";
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="flex gap-3">
        <div className="flex-1 space-y-2">
          <label className="text-xs font-medium" style={{ color: "var(--c-50)" }}>
            First name
          </label>
          <input
            type="text"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            required
            placeholder="Jane"
            className="w-full px-3 py-2.5 rounded-lg text-sm outline-none transition-all"
            style={inputStyle}
            onFocus={focusOn}
            onBlur={focusOff}
          />
        </div>
        <div className="flex-1 space-y-2">
          <label className="text-xs font-medium" style={{ color: "var(--c-50)" }}>
            Last name
          </label>
          <input
            type="text"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            required
            placeholder="Doe"
            className="w-full px-3 py-2.5 rounded-lg text-sm outline-none transition-all"
            style={inputStyle}
            onFocus={focusOn}
            onBlur={focusOff}
          />
        </div>
      </div>

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
          onFocus={focusOn}
          onBlur={focusOff}
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
        className="w-full py-2.5 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
        style={{ background: "oklch(0.72 0.25 285)", color: "oklch(0.08 0 0)" }}
      >
        {loading ? <><Spinner size={14} />Creating account…</> : "Create account"}
      </button>

      <div className="flex items-center gap-3">
        <div className="flex-1 h-px" style={{ background: "var(--bd-8)" }} />
        <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--c-40)" }}>or</span>
        <div className="flex-1 h-px" style={{ background: "var(--bd-8)" }} />
      </div>

      <GoogleSignInButton next="/dashboard" onError={setError} />

      <p className="text-center text-xs" style={{ color: "var(--c-40)" }}>
        Already have an account?{" "}
        <a href="/login" className="transition-colors hover:underline" style={{ color: "var(--c-55)" }}>
          Sign in
        </a>
      </p>
    </form>
  );
}

const VALID_PLANS = ["founder", "starter", "pro"];

export default function SignupPage() {
  const [success, setSuccess] = useState(false);
  const [invitedEmail, setInvitedEmail] = useState("");

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const plan = params.get("plan");
    if (plan && VALID_PLANS.includes(plan)) {
      localStorage.setItem("heclus_selected_plan", plan);
    }
  }, []);

  function handleSuccess(email: string) {
    setInvitedEmail(email);
    setSuccess(true);
  }

  return (
    <div
      className="min-h-screen flex items-center justify-center px-4 pt-24"
      style={{ background: "var(--bg-page)" }}
    >
      <div className="w-full max-w-sm">
        <Link href="/login" className="flex flex-col items-center mb-5 gap-2 transition-opacity hover:opacity-80">
          <div className="w-12 h-12 rounded-xl overflow-hidden" style={{ marginLeft: "6px" }}>
            <Image src="/heclus-icon-white.svg" alt="Heclus" width={48} height={48} className="object-cover w-full h-full" />
          </div>
          <div className="flex flex-col items-center gap-0.5">
            <p className="font-bold text-base tracking-tight">Heclus</p>
            <p className="text-[10px] font-medium tracking-wide" style={{ color: "#888" }}>by aiTrends</p>
          </div>
        </Link>

        <div
          className="rounded-2xl p-6"
          style={{ background: "var(--bg-card)", border: "1px solid oklch(1 0 0 / 0.08)" }}
        >
          {success ? (
            <div className="text-center space-y-2 py-2">
              <p className="text-sm font-semibold" style={{ color: "oklch(0.72 0.25 285)" }}>
                Email sent to your inbox, follow the link to complete your account setup.
              </p>
              <p className="text-xs" style={{ color: "var(--c-45)" }}>
                We sent a link to <span style={{ color: "var(--c-70)" }}>{invitedEmail}</span>.
              </p>
            </div>
          ) : (
            <>
              <h1 className="text-sm font-semibold mb-5" style={{ color: "var(--c-75)" }}>
                Create your account
              </h1>
              <SignupForm onSuccess={handleSuccess} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
