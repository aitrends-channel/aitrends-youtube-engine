"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft, Eye, EyeOff, HardDrive, KeyRound, LogOut, Save, Sparkles, Star, Wallet } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { TopUpOptions } from "@/components/TopUpOptions";

const GB = 1024 ** 3;

function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(bytes >= 10 * GB ? 0 : 1)} GB`;
  const mb = bytes / (1024 ** 2);
  return `${mb >= 10 || mb === 0 ? mb.toFixed(0) : mb.toFixed(1)} MB`;
}

function measuredAgo(iso: string): string {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** Storage meter. Hidden until the usage sweep has measured the account —
 *  a bar reading 0 GB on a user with projects would just look broken. */
function StorageCard() {
  const [status, setStatus] = useState<{
    usedBytes: number; capBytes: number | null; full: boolean; measuredAt: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/storage/usage", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : null)
      .then((d) => { if (!cancelled && d && typeof d.usedBytes === "number") setStatus(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!status?.measuredAt) return null;

  const { usedBytes, capBytes, full, measuredAt } = status;
  const pct = capBytes === null ? 0 : Math.min(usedBytes / capBytes, 1);
  const barColor = full
    ? "oklch(0.6 0.19 25)"
    : pct >= 0.9
      ? "oklch(0.72 0.17 75)"
      : "oklch(0.72 0.25 285)";

  return (
    <div className="space-y-5 pt-8">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: "oklch(0.62 0.15 220 / 0.12)", border: "1px solid oklch(0.62 0.15 220 / 0.25)" }}>
          <HardDrive size={18} style={{ color: "oklch(0.62 0.15 220)" }} />
        </div>
        <div>
          <h2 className="text-lg font-bold text-foreground">Storage</h2>
          <p className="text-xs" style={{ color: "var(--c-45)" }}>
            Images, clips, voiceovers and finished videos across all your projects.
          </p>
        </div>
      </div>

      <div className="p-5 rounded-2xl space-y-3"
        style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" }}>
        <p className="leading-none">
          <span className="text-2xl font-bold tabular-nums" style={{ color: "var(--c-90)" }}>
            {formatBytes(usedBytes)}
          </span>
          <span className="text-xs ml-1.5" style={{ color: "var(--c-50)" }}>
            {capBytes === null ? "used — unlimited on your plan" : `of ${formatBytes(capBytes)} used`}
          </span>
        </p>

        {capBytes !== null && (
          <div className="h-2 rounded-full overflow-hidden" style={{ background: "oklch(0 0 0 / 0.18)" }}>
            <div className="h-full rounded-full transition-all"
              style={{ width: `${Math.max(pct * 100, 1.5)}%`, background: barColor }} />
          </div>
        )}

        <p className="text-[11px] leading-relaxed" style={{ color: full ? "oklch(0.68 0.19 25)" : "var(--c-42)" }}>
          {full
            ? "You're out of storage — delete a project's assets or upgrade your plan to keep generating."
            : "Deleting a project frees its assets."}
          {" "}Measured {measuredAgo(measuredAt)}, refreshed every few hours.
        </p>
      </div>
    </div>
  );
}


/** "Your feedback" card. Rendered only when the user has already
 *  responded to the one-time feedback prompt (row exists) — lets them
 *  revise the rating/text, and lets users who skipped add one later. */
function FeedbackCard() {
  const [loaded, setLoaded] = useState(false);
  const [visible, setVisible] = useState(false);
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [feedbackText, setFeedbackText] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/feedback", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : null)
      .then((d: { hasResponded?: boolean; rating?: number | null; feedbackText?: string | null; firstName?: string | null; lastName?: string | null } | null) => {
        if (cancelled || !d) return;
        setVisible(d.hasResponded === true);
        if (typeof d.rating === "number") setRating(d.rating);
        if (typeof d.feedbackText === "string") setFeedbackText(d.feedbackText);
        if (typeof d.firstName === "string") setFirstName(d.firstName);
        if (typeof d.lastName === "string") setLastName(d.lastName);
        setLoaded(true);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  if (!loaded || !visible) return null;

  async function handleSave() {
    if (rating < 1) {
      toast.error("Please select a rating first");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rating,
          feedbackText: feedbackText.trim() || undefined,
          firstName: firstName.trim() || undefined,
          lastName: lastName.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error ?? "Failed to save feedback");
      }
      toast.success("Feedback saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save feedback");
    } finally {
      setSaving(false);
    }
  }

  const activeRating = hoverRating || rating;

  return (
    <div className="space-y-5 pt-8">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: "oklch(0.75 0.15 85 / 0.12)", border: "1px solid oklch(0.75 0.15 85 / 0.25)" }}>
          <Star size={18} style={{ color: "var(--accent-amber-text)" }} />
        </div>
        <div>
          <h2 className="text-lg font-bold text-foreground">Your feedback</h2>
          <p className="text-xs" style={{ color: "var(--c-45)" }}>
            {rating > 0 ? "Update your rating or feedback anytime." : "You skipped the rating earlier — you can add one here."}
          </p>
        </div>
      </div>

      <div className="p-5 rounded-2xl space-y-4"
        style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" }}>
        <div className="flex items-center gap-1.5">
          {[1, 2, 3, 4, 5].map((n) => {
            const filled = n <= activeRating;
            return (
              <button
                key={n}
                type="button"
                onClick={() => setRating(n)}
                onMouseEnter={() => setHoverRating(n)}
                onMouseLeave={() => setHoverRating(0)}
                disabled={saving}
                aria-label={`Rate ${n} of 5`}
                className="p-0.5 transition-transform hover:scale-110 disabled:cursor-not-allowed"
              >
                <Star
                  size={26}
                  strokeWidth={1.5}
                  className={filled ? "fill-amber-400 stroke-amber-400" : "fill-transparent stroke-current"}
                  style={filled ? undefined : { color: "var(--c-30)" }}
                />
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <label htmlFor="account-feedback-first-name" className="text-xs font-medium" style={{ color: "var(--c-50)" }}>First name</label>
            <input
              id="account-feedback-first-name"
              type="text"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              disabled={saving}
              maxLength={100}
              placeholder="First name"
              className="w-full px-3 py-2.5 rounded-lg text-sm outline-none transition-all disabled:opacity-60"
              style={{ background: "var(--bg-input)", border: "1px solid var(--bd-10)", color: "var(--c-90)" }}
              onFocus={(e) => { e.currentTarget.style.borderColor = "oklch(0.72 0.25 285 / 0.5)"; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-10)"; }}
            />
          </div>
          <div className="space-y-1.5">
            <label htmlFor="account-feedback-last-name" className="text-xs font-medium" style={{ color: "var(--c-50)" }}>Last name</label>
            <input
              id="account-feedback-last-name"
              type="text"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              disabled={saving}
              maxLength={100}
              placeholder="Last name"
              className="w-full px-3 py-2.5 rounded-lg text-sm outline-none transition-all disabled:opacity-60"
              style={{ background: "var(--bg-input)", border: "1px solid var(--bd-10)", color: "var(--c-90)" }}
              onFocus={(e) => { e.currentTarget.style.borderColor = "oklch(0.72 0.25 285 / 0.5)"; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-10)"; }}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="account-feedback-text" className="text-xs font-medium" style={{ color: "var(--c-50)" }}>
            Feedback <span style={{ color: "var(--c-35)" }}>(optional)</span>
          </label>
          <textarea
            id="account-feedback-text"
            value={feedbackText}
            onChange={(e) => setFeedbackText(e.target.value)}
            disabled={saving}
            rows={3}
            maxLength={1000}
            placeholder="What went well, what would you improve…"
            className="w-full px-3 py-2.5 rounded-lg text-sm outline-none transition-all resize-none disabled:opacity-60"
            style={{ background: "var(--bg-input)", border: "1px solid var(--bd-10)", color: "var(--c-90)" }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "oklch(0.72 0.25 285 / 0.5)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-10)"; }}
          />
        </div>

        <div className="flex justify-end pt-1">
          <button
            onClick={handleSave}
            disabled={saving || rating < 1}
            className="px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
            style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
          >
            {saving ? (
              <>
                <span className="w-3.5 h-3.5 border-2 border-current border-t-transparent rounded-full animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Save size={14} />
                Save feedback
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

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

  // Balance moved to its own route. This page keeps the redirect because a
  // completed top-up returns to whatever URL was configured in Dodo, and links
  // to ?section=balance are already out there.
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("section") === "balance") {
      router.replace("/billing");
    }
  }, [router]);

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
                    <Link
                      href="/billing"
                      onClick={() => setShowProfileMenu(false)}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition-all hover:opacity-80"
                      style={{ color: "var(--c-60)" }}
                    >
                      <Wallet size={13} />
                      <span>Billing</span>
                    </Link>
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

      <main className="flex-1 w-full max-w-none px-4 sm:px-8 lg:px-12 py-8 sm:py-14">
        {/* Tabs rather than a sidebar, matching /setup: these two pages are
            siblings, and a two-item sidebar spent a whole column on a choice a
            single row makes just as clearly. */}
        {/* Centred and wider than the old reading column: with tabs across the
            top there is no sidebar to anchor it left, and the ledger reads
            better with room. Still capped, since a password field spanning a
            wide monitor is harder to use, not easier. */}
        <div className="max-w-5xl mx-auto">
          <div className="min-w-0">
        <div className="space-y-5">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
              style={{ background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
              <KeyRound size={18} style={{ color: "var(--brand-text)" }} />
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

          <StorageCard />
          <FeedbackCard />
        </div>
          </div>
        </div>
      </main>
    </div>
  );
}
