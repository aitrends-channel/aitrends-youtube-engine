"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { Spinner } from "@/components/ui/spinner";
import { PageLoader } from "@/components/PageLoader";
import { GoogleSignInButton } from "@/components/auth/GoogleSignInButton";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const errorParam = searchParams.get("error");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Handle invite/recovery hash links that Supabase redirects to /login
    const hash = window.location.hash;
    if (hash) {
      const params = new URLSearchParams(hash.slice(1));
      const type = params.get("type");
      const accessToken = params.get("access_token");
      if (type === "recovery" && accessToken) {
        window.location.replace(`/set-password?reset=true${hash}`);
        return;
      } else if (type === "invite" && accessToken) {
        window.location.replace(`/set-password${hash}`);
        return;
      }
    }
  }, []);

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

      const next = searchParams.get("next") ?? "/dashboard";
      router.push(next);
      router.refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Authentication failed";
      const lower = msg.toLowerCase();
      setError(
        msg === "Failed to fetch" || lower.includes("network") || lower.includes("failed to fetch")
          ? "Unable to reach the server. Check your internet connection and try again."
          : lower.includes("invalid login") || lower.includes("invalid credentials") || lower.includes("wrong password")
          ? "Incorrect email or password. Please try again."
          : lower.includes("email not confirmed") || lower.includes("not confirmed")
          ? "Please verify your email address before signing in. Check your inbox for a confirmation link."
          : lower.includes("too many requests") || lower.includes("rate limit")
          ? "Too many sign-in attempts. Please wait a few minutes and try again."
          : lower.includes("user not found") || lower.includes("no user")
          ? "No account found with that email address."
          : lower.includes("disabled") || lower.includes("banned")
          ? "This account has been disabled. Contact support for help."
          : "Sign-in failed. Please check your details and try again."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
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
        className="w-full py-2.5 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
        style={{ background: "oklch(0.72 0.25 285)", color: "oklch(0.08 0 0)" }}
      >
        {loading ? <><Spinner size={14} />Signing in…</> : "Sign In"}
      </button>

      <div className="flex items-center gap-3">
        <div className="flex-1 h-px" style={{ background: "var(--bd-8)" }} />
        <span className="text-[10px] uppercase tracking-wider" style={{ color: "var(--c-40)" }}>or</span>
        <div className="flex-1 h-px" style={{ background: "var(--bd-8)" }} />
      </div>

      <GoogleSignInButton next={searchParams.get("next") ?? "/dashboard"} onError={setError} />

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
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        router.replace("/dashboard");
      } else {
        setReady(true);
      }
    });
  }, [router]);

  if (!ready) return <PageLoader />;

  return (
    <div className="min-h-screen flex items-center justify-center px-4"
      style={{ background: "var(--bg-page)" }}>
      <div className="w-full max-w-md">
        <Link href="/login" className="flex flex-col items-center mb-5 gap-2 transition-opacity hover:opacity-80">
          <div className="w-12 h-12 rounded-xl overflow-hidden" style={{ marginLeft: "6px" }}>
            <Image src="/heclus-icon-white.svg" alt="Heclus" width={48} height={48} className="object-cover w-full h-full" />
          </div>
          <div className="flex flex-col items-center gap-0.5">
            <p className="font-bold text-base tracking-tight">Heclus</p>
            <p className="text-[10px] font-medium tracking-wide" style={{ color: "#888" }}>by aiTrends</p>
          </div>
        </Link>

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
