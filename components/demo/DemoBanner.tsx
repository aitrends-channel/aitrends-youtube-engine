"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Settings, LogOut } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export function DemoBanner() {
  const router = useRouter();
  const [showMenu, setShowMenu] = useState(false);
  const [userEmail, setUserEmail] = useState("");

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getUser().then(({ data }) => {
      if (data.user?.email) setUserEmail(data.user.email);
    });
  }, []);

  async function handleSignOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <>
      {/* Spacer so content clears the fixed mobile nav (h-14 top bar + h-8 dots strip + 1px border) */}
      <div className="h-[89px] md:hidden shrink-0" />
    <div
      className="flex items-center justify-between px-4 sm:px-6 py-2.5 text-xs shrink-0"
      style={{
        background: "oklch(0.72 0.25 285 / 0.12)",
        borderBottom: "1px solid oklch(0.72 0.25 285 / 0.2)",
        color: "var(--c-65)",
      }}
    >
      <span className="hidden sm:inline">✨ You&apos;re viewing a demo — subscribe to run this on your own channel.</span>
      <span className="sm:hidden">✨ Demo mode</span>

      <div className="flex items-center gap-3 shrink-0 ml-4">
        <button
          onClick={() => router.push("/dashboard")}
          className="px-3 py-1 rounded-lg text-xs font-semibold transition-all hover:opacity-90"
          style={{ background: "oklch(0.72 0.25 285)", color: "oklch(0.06 0 0)" }}
        >
          Subscribe Now →
        </button>

        <button
          onClick={() => router.push("/dashboard")}
          className="hidden sm:block px-3 py-1 rounded-lg text-xs font-medium transition-all hover:opacity-80"
          style={{ background: "var(--bg-control)", color: "var(--c-60)", border: "1px solid var(--bd-8)" }}
        >
          Dashboard
        </button>

        <ThemeToggle />

        {/* Profile avatar + dropdown */}
        <div className="relative">
          <button
            onClick={() => setShowMenu((v) => !v)}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-xs font-bold transition-all hover:opacity-80 cursor-pointer shrink-0"
            style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
          >
            {userEmail ? userEmail[0].toUpperCase() : "?"}
          </button>

          {showMenu && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)} />
              <div
                className="absolute right-0 top-9 z-50 w-56 rounded-2xl py-3 shadow-2xl"
                style={{ background: "var(--bg-card)", border: "1px solid oklch(1 0 0 / 0.1)" }}
              >
                <div className="px-4 pb-3" style={{ borderBottom: "1px solid oklch(1 0 0 / 0.07)" }}>
                  <p className="text-xs font-semibold truncate" style={{ color: "var(--c-88)" }}>
                    {userEmail || "Loading…"}
                  </p>
                  <span
                    className="mt-1.5 inline-block text-[10px] font-semibold px-2 py-0.5 rounded-full"
                    style={{
                      background: "oklch(0.72 0.25 285 / 0.15)",
                      color: "oklch(0.72 0.25 285)",
                      border: "1px solid oklch(0.72 0.25 285 / 0.25)",
                    }}
                  >
                    Free plan
                  </span>
                </div>
                <div className="px-2 pt-2">
                  <button
                    onClick={() => { setShowMenu(false); router.push("/setup"); }}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition-all hover:opacity-80 cursor-pointer"
                    style={{ color: "var(--c-60)" }}
                  >
                    <Settings size={13} />
                    <span>Setup</span>
                  </button>
                  <button
                    onClick={() => { setShowMenu(false); handleSignOut(); }}
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
    </div>
    </>
  );
}
