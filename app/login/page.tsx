"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const errorParam = searchParams.get("error");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) { router.replace("/"); return; }

      // Supabase recovery/invite links may land here if the project Site URL points to /login.
      // Detect the tokens and forward to /set-password before showing the login form.
      const hash = window.location.hash;
      if (!hash) return;
      const params = new URLSearchParams(hash.slice(1));
      const type = params.get("type");
      const accessToken = params.get("access_token");
      if (type === "recovery" && accessToken) {
        router.replace(`/set-password?reset=true${hash}`);
      } else if (type === "invite" && accessToken) {
        router.replace(`/set-password${hash}`);
      }
    });
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const supabase = createSupabaseBrowserClient();
    try {
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError) throw authError;

      const check = await fetch("/api/auth/check-access", { method: "POST" });
      if (!check.ok) {
        window.location.href = "/login?error=unauthorized";
        return;
      }

      const next = searchParams.get("next") ?? "/";
      router.push(next);
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Authentication failed";
      setError(
        msg === "Failed to fetch" || msg.toLowerCase().includes("network")
          ? "Unable to reach the server. Check your internet connection and try again."
          : msg
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {errorParam === "unauthorized" && (
        <p className="text-xs px-3 py-2 rounded-lg"
          style={{ background: "oklch(0.6 0.22 25 / 0.1)", color: "oklch(0.7 0.2 25)", border: "1px solid oklch(0.6 0.22 25 / 0.2)" }}>
          Your account doesn&apos;t have access. Contact the administrator to get access.
        </p>
      )}

      <div className="space-y-2">
        <label className="text-xs font-medium" style={{ color: "var(--c-50)" }}>Email</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          placeholder="you@example.com"
          className="w-full px-3 py-2.5 rounded-lg text-sm outline-none transition-all"
          style={{
            background: "var(--bg-input)",
            border: "1px solid var(--bd-10)",
            color: "var(--c-90)",
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = "oklch(0.72 0.25 285 / 0.5)"; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-10)"; }}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium" style={{ color: "var(--c-50)" }}>Password</label>
          <a href="/forgot-password" className="text-xs transition-colors hover:underline" style={{ color: "var(--c-55)" }}>
            Forgot password?
          </a>
        </div>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          placeholder="••••••••"
          className="w-full px-3 py-2.5 rounded-lg text-sm outline-none transition-all"
          style={{
            background: "var(--bg-input)",
            border: "1px solid var(--bd-10)",
            color: "var(--c-90)",
          }}
          onFocus={(e) => { e.currentTarget.style.borderColor = "oklch(0.72 0.25 285 / 0.5)"; }}
          onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-10)"; }}
        />
      </div>

      {error && (
        <p className="text-xs px-3 py-2 rounded-lg" style={{ background: "oklch(0.6 0.22 25 / 0.1)", color: "oklch(0.7 0.2 25)", border: "1px solid oklch(0.6 0.22 25 / 0.2)" }}>
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full py-2.5 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
        style={{ background: "oklch(0.72 0.25 285)", color: "oklch(0.08 0 0)" }}
      >
        {loading ? "…" : "Sign In"}
      </button>

      <p className="text-center text-xs" style={{ color: "var(--c-40)" }}>
        Don&apos;t have an account?{" "}
        <a href="/signup" className="transition-colors hover:underline" style={{ color: "var(--c-55)" }}>
          Sign up
        </a>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4"
      style={{ background: "var(--bg-page)" }}>
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

        <div className="rounded-2xl p-6"
          style={{ background: "var(--bg-card)", border: "1px solid oklch(1 0 0 / 0.08)" }}>
          <Suspense>
            <LoginForm />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
