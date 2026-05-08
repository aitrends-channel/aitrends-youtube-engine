"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

function SetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isReset = searchParams.get("reset") === "true";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();

    async function setupSession() {
      // PKCE flow: code in search params
      const code = new URLSearchParams(window.location.search).get("code");
      if (code) {
        const { data, error } = await supabase.auth.exchangeCodeForSession(code);
        if (!error && data.session) { setSessionReady(true); return; }
      }

      // Implicit flow: tokens in hash (from admin.generateLink or site-URL fallback)
      const hash = window.location.hash;
      if (hash) {
        const hp = new URLSearchParams(hash.slice(1));
        const accessToken = hp.get("access_token");
        const refreshToken = hp.get("refresh_token");
        if (accessToken) {
          const { data, error } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken ?? "",
          });
          if (!error && data.session) { setSessionReady(true); return; }
        }
      }

      // Already signed in
      const { data: { session } } = await supabase.auth.getSession();
      if (session) { setSessionReady(true); return; }

      router.replace("/login");
    }

    setupSession();
  }, [router]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setError("Passwords do not match."); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    setError(null);
    setLoading(true);
    const supabase = createSupabaseBrowserClient();
    try {
      const { error: updateError } = await supabase.auth.updateUser({
        password,
        data: { must_change_password: false },
      });
      if (updateError) throw updateError;
      router.push("/");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set password");
    } finally {
      setLoading(false);
    }
  }

  const inputStyle = {
    background: "var(--bg-input)",
    border: "1px solid var(--bd-10)",
    color: "var(--c-90)",
  };

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
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              {isReset ? "Reset your password" : "Create your password"}
            </p>
          </div>
        </div>

        <div className="rounded-2xl p-6"
          style={{ background: "var(--bg-card)", border: "1px solid var(--bd-8)" }}>

          {error && (
            <p className="text-xs px-3 py-2 rounded-lg mb-4"
              style={{ background: "oklch(0.6 0.22 25 / 0.1)", color: "oklch(0.7 0.2 25)", border: "1px solid oklch(0.6 0.22 25 / 0.2)" }}>
              {error}
            </p>
          )}


            <>
              <p className="text-sm mb-5" style={{ color: "var(--c-50)" }}>
                {isReset ? "Set a new password for your account" : "Complete your account setup"}
              </p>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs font-medium" style={{ color: "var(--c-50)" }}>
                    Password
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete="new-password"
                    placeholder="At least 8 characters"
                    className="w-full px-3 py-2.5 rounded-lg text-sm outline-none transition-all"
                    style={inputStyle}
                    onFocus={(e) => { e.currentTarget.style.borderColor = "oklch(0.72 0.25 285 / 0.5)"; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-10)"; }}
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-xs font-medium" style={{ color: "var(--c-50)" }}>Confirm Password</label>
                  <input
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                    autoComplete="new-password"
                    placeholder="Repeat your password"
                    className="w-full px-3 py-2.5 rounded-lg text-sm outline-none transition-all"
                    style={inputStyle}
                    onFocus={(e) => { e.currentTarget.style.borderColor = "oklch(0.72 0.25 285 / 0.5)"; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-10)"; }}
                  />
                </div>

                {error && (
                  <p className="text-xs px-3 py-2 rounded-lg"
                    style={{ background: "oklch(0.6 0.22 25 / 0.1)", color: "oklch(0.7 0.2 25)", border: "1px solid oklch(0.6 0.22 25 / 0.2)" }}>
                    {error}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
                  style={{ background: "oklch(0.72 0.25 285)", color: "oklch(0.08 0 0)" }}
                >
                  {loading ? "…" : isReset ? "Set new password" : "Set Password & Continue"}
                </button>
              </form>
            </>

        </div>
      </div>
    </div>
  );
}

export default function SetPasswordPage() {
  return (
    <Suspense>
      <SetPasswordForm />
    </Suspense>
  );
}
