"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ThemeToggle } from "@/components/ThemeToggle";
import { BalanceCards } from "@/components/balance/BalanceCards";
import { FundingModeCard } from "@/components/balance/FundingModeCard";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

// Balance on its own route.
//
// It was a second pane on the account page, which made it a place you had to
// know to look inside a page about API keys and passwords. Money deserves its
// own URL: it can be linked to, it is where a completed top-up returns, and the
// profile menu points straight at it. /account?section=balance still redirects
// here so older links and any configured payment return URL keep working.
//
// A lean shell rather than the account page's full header: someone arrives here
// from the profile menu they just opened, so a second copy of that menu earns
// nothing and Back is what they actually want.
export default function BalancePage() {
  const router = useRouter();
  const [email, setEmail] = useState("");

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getUser().then(({ data }) => {
      // No session means nothing here is theirs to see.
      if (!data.user) { router.replace("/login"); return; }
      setEmail(data.user.email ?? "");
    });
  }, [router]);

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--bg-page)" }}>
      <header className="flex items-center justify-between px-4 sm:px-8 py-4 sticky top-0 z-10"
        style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header)", backdropFilter: "blur(16px)" }}>
        <Link href="/dashboard" className="flex items-center gap-3 min-w-0 transition-opacity hover:opacity-80">
          <div className="w-8 h-8 shrink-0 rounded-xl flex items-center justify-center">
            <Image src="/heclus-icon-white.svg" alt="Heclus" width={32} height={32} className="object-cover w-full h-full" />
          </div>
          <div className="min-w-0">
            <span className="font-bold text-sm tracking-tight text-foreground">Heclus</span>
            <span className="text-sm tracking-tight ml-1 hidden sm:inline" style={{ color: "var(--c-50)" }}>Balance</span>
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
        </div>
      </header>

      <main className="flex-1 px-4 sm:px-8 py-8">
        {/* Wider than the account page's reading column: two wallets with a
            ledger each need the room, and nothing here is a text field where a
            long line hurts. */}
        <div className="max-w-7xl mx-auto space-y-6">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Balance</h1>
            <p className="text-sm mt-1" style={{ color: "var(--c-45)" }}>
              What you can spend, and where it went.
              {email ? <span style={{ color: "var(--c-35)" }}> {email}</span> : null}
            </p>
          </div>
          <BalanceCards />
          <FundingModeCard />
        </div>
      </main>
    </div>
  );
}
