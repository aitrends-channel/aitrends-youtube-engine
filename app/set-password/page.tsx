"use client";

import { useState, useEffect, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Image from "next/image";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { Spinner } from "@/components/ui/spinner";

function SetPasswordForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isReset = searchParams.get("reset") === "true";
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();

    async function setup() {
      // 1. Hash tokens take priority — always process them when present so a
      //    stale session from a previous user never shadows a fresh invite link.
      const hash = window.location.hash;
      if (hash) {
        const p = new URLSearchParams(hash.slice(1));
        const accessToken = p.get("access_token");
        const refreshToken = p.get("refresh_token") ?? "";
        if (accessToken) {
          await supabase.auth.signOut();
          const { error: sessionError } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          if (!sessionError) { setChecking(false); return; }
        }
      }

      // 2. PKCE flow: some paths (e.g. user-initiated reset) may land with ?code=
      const code = new URLSearchParams(window.location.search).get("code");
      if (code) {
        const { error: codeError } = await supabase.auth.exchangeCodeForSession(code);
        if (!codeError) { setChecking(false); return; }
      }

      // 3. No hash or code — check for an existing valid session (navigated back)
      const { data: { session } } = await supabase.auth.getSession();
      if (session) { setChecking(false); return; }

      // 4. Nothing worked — link is expired or invalid
      setLinkError("This link has expired or is invalid. Request a new one.");
      setChecking(false);
    }

    setup().catch(() => {
      setLinkError("Something went wrong verifying your link. Please try again.");
      setChecking(false);
    });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) { setFormError("Passwords do not match."); return; }
    if (password.length < 8) { setFormError("Password must be at least 8 characters."); return; }
    setFormError(null);
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
      setFormError(err instanceof Error ? err.message : "Failed to set password");
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
          <div className="w-14 h-14 rounded-xl">
            <Image src="/logo.png" alt="Heclus" width={56} height={56} className="object-cover w-full h-full" />
          </div>
          <div className="text-center">
            <p className="font-bold text-lg tracking-tight">Heclus</p>
            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
              {isReset ? "Reset your password" : "Create your password"}
            </p>
          </div>
        </div>

        <div className="rounded-2xl p-6"
          style={{ background: "var(--bg-card)", border: "1px solid var(--bd-8)" }}>

          {checking ? (
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <Spinner size={22} className="text-purple-400" />
              <span className="text-sm" style={{ color: "var(--c-45)" }}>Verifying your link…</span>
            </div>
          ) : linkError ? (
            <p className="text-xs px-3 py-2 rounded-lg"
              style={{ background: "oklch(0.6 0.22 25 / 0.1)", color: "oklch(0.7 0.2 25)", border: "1px solid oklch(0.6 0.22 25 / 0.2)" }}>
              {linkError}
            </p>
          ) : (
            <>
              <p className="text-sm mb-5" style={{ color: "var(--c-50)" }}>
                {isReset ? "Set a new password for your account" : "Complete your account setup"}
              </p>

              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <label className="text-xs font-medium" style={{ color: "var(--c-50)" }}>Password</label>
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

                {formError && (
                  <p className="text-xs px-3 py-2 rounded-lg"
                    style={{ background: "oklch(0.6 0.22 25 / 0.1)", color: "oklch(0.7 0.2 25)", border: "1px solid oklch(0.6 0.22 25 / 0.2)" }}>
                    {formError}
                  </p>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-2.5 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 flex items-center justify-center gap-2"
                  style={{ background: "oklch(0.72 0.25 285)", color: "oklch(0.08 0 0)" }}
                >
                  {loading ? <><Spinner size={14} />Saving…</> : isReset ? "Set new password" : "Set Password & Continue"}
                </button>
              </form>
            </>
          )}

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
