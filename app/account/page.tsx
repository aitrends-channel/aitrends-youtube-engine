"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, Eye, EyeOff, KeyRound, LogOut, Save } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

/**
 * Standalone /account page. Used to be a tab on /setup; lifted to its
 * own route so every profile-menu in the app can link to it directly
 * regardless of context. Shell mirrors /setup's header (brand, Back,
 * ThemeToggle, profile avatar) so the page sits naturally next to
 * Setup without the user feeling like they hopped to a different app.
 *
 * Password form adapts to two cases:
 *
 *  - **Set password** (Google-only sign-ups): no `email` identity
 *    yet, so we don't ask for a current password. After Supabase
 *    accepts the new password, an email identity is attached and
 *    the user can sign in with email + password too.
 *
 *  - **Change password** (already has an email identity): we ask for
 *    the current password and verify it via signInWithPassword
 *    before calling updateUser. Cheap reauth that prevents a leaked
 *    session from quietly hijacking the account.
 */
export default function AccountPage() {
  const router = useRouter();

  // ── Header state ──────────────────────────────────────────────
  const [userEmail, setUserEmail] = useState("");
  const [showProfileMenu, setShowProfileMenu] = useState(false);

  // ── Form state ────────────────────────────────────────────────
  const [loading, setLoading] = useState(true);
  const [hasPassword, setHasPassword] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState<{ current: boolean; next: boolean; confirm: boolean }>({
    current: false, next: false, confirm: false,
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getUser().then(({ data }) => {
      const u = data.user;
      if (!u) {
        router.replace("/login");
        return;
      }
      setUserEmail(u.email ?? "");
      const hasEmailIdentity = (u.identities ?? []).some((i) => i.provider === "email");
      setHasPassword(hasEmailIdentity);
    }).finally(() => setLoading(false));
  }, [router]);

  async function handleSignOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (next.length < 8) {
      toast.error("Password must be at least 8 characters.");
      return;
    }
    if (next !== confirm) {
      toast.error("New password and confirmation don't match.");
      return;
    }
    if (hasPassword && !current) {
      toast.error("Enter your current password to change it.");
      return;
    }

    setSaving(true);
    const supabase = createSupabaseBrowserClient();
    try {
      if (hasPassword) {
        const { error: reauthErr } = await supabase.auth.signInWithPassword({
          email: userEmail,
          password: current,
        });
        if (reauthErr) {
          throw new Error("Current password is incorrect.");
        }
      }
      const { error } = await supabase.auth.updateUser({ password: next });
      if (error) throw new Error(error.message);

      toast.success(hasPassword ? "Password updated." : "Password set. You can now sign in with email + password too.");
      setCurrent("");
      setNext("");
      setConfirm("");
      // Once a password exists, flip into "change" mode immediately so
      // a second submit without refresh asks for the password we just
      // set rather than skipping reauth.
      setHasPassword(true);
      // Push updated session cookies + identity list to any server
      // components that already rendered against the pre-password
      // user object. Without this, RSC-driven surfaces (nav, header
      // avatar, etc.) show the stale identity set until the user
      // manually reloads the page.
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update password.");
    } finally {
      setSaving(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    background: "var(--bg-input)",
    border: "1px solid var(--bd-10)",
    color: "var(--c-90)",
  };

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--bg-page)" }}>
      {/* Header — same shell as /setup so the page sits naturally
          beside it. */}
      <header className="flex items-center justify-between px-4 sm:px-8 py-4 sticky top-0 z-10"
        style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header)", backdropFilter: "blur(16px)" }}>
        <Link href="/dashboard" className="flex items-center gap-3 min-w-0 transition-opacity hover:opacity-80">
          <div className="w-8 h-8 shrink-0 rounded-xl flex items-center justify-center">
            <Image src="/heclus-icon-white.svg" alt="Heclus" width={32} height={32} className="object-cover w-full h-full" />
          </div>
          <div className="min-w-0">
            <span className="font-bold text-sm tracking-tight text-foreground">Heclus</span>
            <span className="text-sm tracking-tight ml-1 hidden sm:inline" style={{ color: "var(--c-50)" }}>Account</span>
          </div>
        </Link>
        <div className="flex items-center gap-2 shrink-0">
          <button
            onClick={() => router.push("/dashboard")}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all hover:opacity-80"
            style={{ background: "transparent", color: "var(--c-55)", border: "1px solid var(--bd-8)" }}
          >
            <ArrowLeft size={13} />
            Back
          </button>
          <ThemeToggle />
          <div className="relative">
            <button
              onClick={() => setShowProfileMenu((v) => !v)}
              className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold transition-all hover:opacity-80 cursor-pointer shrink-0"
              style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
            >
              {userEmail ? userEmail[0].toUpperCase() : "?"}
            </button>
            {showProfileMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowProfileMenu(false)} />
                <div className="absolute right-0 top-11 z-50 w-56 rounded-2xl py-3 shadow-2xl"
                  style={{ background: "var(--bg-card)", border: "1px solid oklch(1 0 0 / 0.1)" }}
                >
                  <div className="px-4 pb-3" style={{ borderBottom: "1px solid oklch(1 0 0 / 0.07)" }}>
                    <p className="text-xs font-semibold truncate" style={{ color: "var(--c-88)" }}>
                      {userEmail || "Loading…"}
                    </p>
                  </div>
                  <div className="px-2 pt-2">
                    <button
                      onClick={() => { setShowProfileMenu(false); handleSignOut(); }}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition-all hover:opacity-80 cursor-pointer"
                      style={{ color: "#f87171" }}
                    >
                      <LogOut size={13} />
                      <span>Sign Out</span>
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      <main className="flex-1 w-full max-w-2xl mx-auto px-4 sm:px-8 py-8 sm:py-14">
        <div className="space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
              <KeyRound size={18} style={{ color: "oklch(0.72 0.25 285)" }} />
            </div>
            <div>
              <h1 className="text-lg font-bold text-foreground">
                {loading ? "Account password" : hasPassword ? "Change password" : "Set password"}
              </h1>
              <p className="text-xs" style={{ color: "var(--c-45)" }}>
                {loading
                  ? "Loading…"
                  : hasPassword
                  ? "Update your account password. You'll need your current password to confirm."
                  : "You signed up with a third-party provider. Set a password so you can sign in with email + password too."}
              </p>
            </div>
          </div>

          {!loading && (
            <form onSubmit={handleSubmit} className="p-5 rounded-2xl space-y-4"
              style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" }}>

              {hasPassword && (
                <div className="space-y-1.5">
                  <label className="text-xs font-medium" style={{ color: "var(--c-50)" }}>Current password</label>
                  <div className="relative">
                    <input
                      type={show.current ? "text" : "password"}
                      value={current}
                      onChange={(e) => setCurrent(e.target.value)}
                      autoComplete="current-password"
                      className="w-full px-3 py-2.5 pr-10 rounded-lg text-sm outline-none transition-all"
                      style={inputStyle}
                      onFocus={(e) => { e.currentTarget.style.borderColor = "oklch(0.72 0.25 285 / 0.5)"; }}
                      onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-10)"; }}
                    />
                    <button type="button" tabIndex={-1}
                      onClick={() => setShow((s) => ({ ...s, current: !s.current }))}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:opacity-80"
                      aria-label={show.current ? "Hide password" : "Show password"}
                      style={{ color: "var(--c-50)" }}>
                      {show.current ? <EyeOff size={14} /> : <Eye size={14} />}
                    </button>
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs font-medium" style={{ color: "var(--c-50)" }}>New password</label>
                <div className="relative">
                  <input
                    type={show.next ? "text" : "password"}
                    value={next}
                    onChange={(e) => setNext(e.target.value)}
                    autoComplete="new-password"
                    placeholder="At least 8 characters"
                    className="w-full px-3 py-2.5 pr-10 rounded-lg text-sm outline-none transition-all"
                    style={inputStyle}
                    onFocus={(e) => { e.currentTarget.style.borderColor = "oklch(0.72 0.25 285 / 0.5)"; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-10)"; }}
                  />
                  <button type="button" tabIndex={-1}
                    onClick={() => setShow((s) => ({ ...s, next: !s.next }))}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:opacity-80"
                    aria-label={show.next ? "Hide password" : "Show password"}
                    style={{ color: "var(--c-50)" }}>
                    {show.next ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium" style={{ color: "var(--c-50)" }}>Confirm new password</label>
                <div className="relative">
                  <input
                    type={show.confirm ? "text" : "password"}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    autoComplete="new-password"
                    className="w-full px-3 py-2.5 pr-10 rounded-lg text-sm outline-none transition-all"
                    style={inputStyle}
                    onFocus={(e) => { e.currentTarget.style.borderColor = "oklch(0.72 0.25 285 / 0.5)"; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-10)"; }}
                  />
                  <button type="button" tabIndex={-1}
                    onClick={() => setShow((s) => ({ ...s, confirm: !s.confirm }))}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded hover:opacity-80"
                    aria-label={show.confirm ? "Hide password" : "Show password"}
                    style={{ color: "var(--c-50)" }}>
                    {show.confirm ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>

              <div className="flex justify-end pt-1">
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
                  style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
                >
                  <Save size={14} />
                  {saving ? "Saving…" : hasPassword ? "Update password" : "Set password"}
                </button>
              </div>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
