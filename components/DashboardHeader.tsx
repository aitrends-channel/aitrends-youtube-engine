"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { Settings, LogOut, BarChart3, KeyRound, Wallet } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { isAdminEmail } from "@/lib/admin";
import { ThemeToggle } from "@/components/ThemeToggle";
import { KieBalanceRow } from "@/components/KieBalanceRow";
import { ElevenLabsBalanceRow } from "@/components/ElevenLabsBalanceRow";

interface DashboardHeaderProps {
  /** Extra slot at the right edge — for page-specific primary actions. */
  rightExtra?: React.ReactNode;
}

export function DashboardHeader({ rightExtra }: DashboardHeaderProps) {
  const router = useRouter();
  const [userEmail, setUserEmail] = useState("");
  const [isAdmin, setIsAdmin] = useState(false);
  const [isPaid, setIsPaid] = useState<boolean | null>(null);
  const [userPlan, setUserPlan] = useState<string>("starter");
  const [memberSince, setMemberSince] = useState<string>("");
  const [showProfileMenu, setShowProfileMenu] = useState(false);
  const profileMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (profileMenuRef.current && !profileMenuRef.current.contains(e.target as Node)) {
        setShowProfileMenu(false);
      }
    }
    if (!showProfileMenu) return;
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [showProfileMenu]);

  useEffect(() => {
    let cancelled = false;
    const supabase = createSupabaseBrowserClient();

    function applyUser(user: { email?: string | null; created_at?: string; app_metadata?: Record<string, unknown> }) {
      if (cancelled) return;
      setUserEmail(user.email ?? "");
      if (isAdminEmail(user.email)) setIsAdmin(true);
      if (user.created_at) {
        setMemberSince(new Date(user.created_at).toLocaleDateString("en", { month: "short", year: "numeric" }));
      }
      setIsPaid(user.app_metadata?.paid === true);
      if (user.app_metadata?.plan) setUserPlan(user.app_metadata.plan as string);
    }

    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled) return;
      if (session?.user) applyUser(session.user as Parameters<typeof applyUser>[0]);
    });
    supabase.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      if (data.user) applyUser(data.user as Parameters<typeof applyUser>[0]);
    });

    return () => { cancelled = true; };
  }, []);

  async function handleSignOut() {
    try { sessionStorage.removeItem("demo_state_v1"); } catch { /* ignore */ }
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <header className="flex items-center justify-between px-4 sm:px-8 py-3 sm:py-4 sticky top-0 z-50"
      style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header)", backdropFilter: "blur(16px)" }}>
      <Link href="/dashboard" className="flex items-center gap-3 transition-opacity hover:opacity-80">
        <div className="w-8 h-8 shrink-0 rounded-xl flex items-center justify-center">
          <Image src="/heclus-icon-white.svg" alt="Heclus" width={32} height={32} className="object-cover w-full h-full" />
        </div>
        <div>
          <span className="font-bold text-sm tracking-tight text-foreground">Heclus</span>
        </div>
      </Link>
      <div className="flex items-center gap-3">
        {isAdmin && (
          <Link
            href="/admin"
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all hover:opacity-80"
            style={{ background: "oklch(0.72 0.25 285 / 0.1)", color: "var(--brand-text)", border: "1px solid oklch(0.72 0.25 285 / 0.2)" }}
          >
            <BarChart3 size={15} />
            <span>Admin</span>
          </Link>
        )}
        <ThemeToggle />
        <div className="relative" ref={profileMenuRef}>
          <button
            onClick={() => setShowProfileMenu(v => !v)}
            className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold transition-all hover:opacity-80 cursor-pointer shrink-0"
            style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
          >
            {userEmail ? userEmail[0].toUpperCase() : "?"}
          </button>

          {showProfileMenu && (
            <div className="absolute right-0 top-12 z-[200] w-64 rounded-2xl py-3 shadow-2xl"
              style={{ background: "var(--bg-card)", border: "1px solid var(--bd-10)" }}>
              <div className="px-4 pb-3" style={{ borderBottom: "1px solid var(--bd-7)" }}>
                <div className="flex items-center gap-3 mb-3">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center text-base font-bold shrink-0"
                    style={{ background: "oklch(0.72 0.25 285)", color: "white" }}>
                    {userEmail ? userEmail[0].toUpperCase() : "?"}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold truncate" style={{ color: "var(--c-88)" }}>{userEmail}</p>
                    {memberSince && (
                      <p className="text-[10px]" style={{ color: "var(--c-38)" }}>Member since {memberSince}</p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {isAdmin ? (
                    <span className="text-[10px] font-semibold px-2.5 py-1 rounded-full capitalize"
                      style={{ background: "oklch(0.55 0.15 145 / 0.15)", color: "oklch(0.65 0.15 145)", border: "1px solid oklch(0.55 0.15 145 / 0.25)" }}>
                      Admin
                    </span>
                  ) : (
                    <Link
                      href="/plan"
                      onClick={() => setShowProfileMenu(false)}
                      className="text-[10px] font-semibold px-2.5 py-1 rounded-full capitalize transition-opacity hover:opacity-75"
                      style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "var(--brand-text)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
                      {isPaid ? userPlan : "Free"} plan →
                    </Link>
                  )}
                </div>
              </div>

              <KieBalanceRow />
              <ElevenLabsBalanceRow />

              <div className="px-2 pt-2">
                <Link
                  href="/setup"
                  onClick={() => setShowProfileMenu(false)}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all hover:opacity-80"
                  style={{ color: "var(--c-60)" }}
                >
                  <Settings size={15} />
                  <span>Config</span>
                </Link>
                <Link
                  href="/account"
                  onClick={() => setShowProfileMenu(false)}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all hover:opacity-80"
                  style={{ color: "var(--c-60)" }}
                >
                  <KeyRound size={15} />
                  <span>Account</span>
                </Link>
                <Link
                  href="/billing"
                  onClick={() => setShowProfileMenu(false)}
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all hover:opacity-80"
                  style={{ color: "var(--c-60)" }}
                >
                  <Wallet size={15} />
                  <span>Billing</span>
                </Link>
                <button
                  onClick={() => { setShowProfileMenu(false); handleSignOut(); }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm transition-all hover:opacity-80 cursor-pointer"
                  style={{ color: "#f87171" }}
                >
                  <LogOut size={15} />
                  <span>Sign Out</span>
                </button>
              </div>
            </div>
          )}
        </div>
        {rightExtra}
      </div>
    </header>
  );
}
