"use client";

import { useState } from "react";
import Image from "next/image";

function SignupForm() {
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch(`/api/auth/signup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ first_name: firstName, last_name: lastName, email }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.message ?? `Request failed (${res.status})`);
      }
      setSuccess(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Signup failed";
      setError(
        msg === "Failed to fetch" || msg.toLowerCase().includes("network")
          ? "Unable to reach the server. Check your connection and try again."
          : msg
      );
    } finally {
      setLoading(false);
    }
  }

  if (success) {
    return (
      <div className="text-center space-y-2 py-2">
        <p className="text-sm font-semibold" style={{ color: "oklch(0.72 0.25 285)" }}>
          You&apos;re on the list!
        </p>
        <p className="text-xs" style={{ color: "var(--c-45)" }}>
          We&apos;ll be in touch at <span style={{ color: "var(--c-70)" }}>{email}</span>.
        </p>
      </div>
    );
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
    <form onSubmit={handleSubmit} className="space-y-4">
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
        className="w-full py-2.5 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
        style={{ background: "oklch(0.72 0.25 285)", color: "oklch(0.08 0 0)" }}
      >
        {loading ? "…" : "Create account"}
      </button>

      <p className="text-center text-xs" style={{ color: "var(--c-40)" }}>
        Already have an account?{" "}
        <a href="/login" className="transition-colors hover:underline" style={{ color: "var(--c-55)" }}>
          Sign in
        </a>
      </p>
    </form>
  );
}

export default function SignupPage() {
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
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              YT Workflow
            </p>
          </div>
        </div>

        <div
          className="rounded-2xl p-6"
          style={{ background: "var(--bg-card)", border: "1px solid oklch(1 0 0 / 0.08)" }}
        >
          <h1 className="text-sm font-semibold mb-5" style={{ color: "var(--c-75)" }}>
            Create your account
          </h1>
          <SignupForm />
        </div>
      </div>
    </div>
  );
}
