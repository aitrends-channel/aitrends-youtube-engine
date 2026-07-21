"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Settings, Eye, EyeOff, ArrowLeft, Save, CheckCircle2, LogOut, UserPlus, BookOpen, KeyRound, SlidersHorizontal, CreditCard, Gift, Users } from "lucide-react";
import { OneClickConfigPanel } from "@/components/one-click/OneClickConfigPanel";
import { Spinner } from "@/components/ui/spinner";
import { ThemeToggle } from "@/components/ThemeToggle";
import Image from "next/image";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { FREE_TIER_COMING_SOON } from "@/lib/free-tier-flag";

type Tier = "paid" | "free";

// Inline external link used across the Instructions steps — one style,
// always opens in a new tab, so every step can carry a direct link.
function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      style={{ color: "oklch(0.72 0.25 285)", textDecoration: "underline" }}>
      {children} ↗
    </a>
  );
}

// TEMPORARY (lib/free-tier-flag.ts): shared "coming soon" card shown in
// place of the Free sub-tab's key fields / instructions while the free
// tier is paused. The functional content below stays intact.
function FreeComingSoonCard() {
  return (
    <div className="rounded-2xl px-4 py-10 text-center max-w-xl"
      style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" }}>
      <p className="text-base font-bold" style={{ color: "oklch(0.72 0.25 285)" }}>
        Great Good News!
      </p>
      <p className="text-sm font-medium mt-2" style={{ color: "var(--c-70)" }}>
        Thank you for choosing us and for being part of our journey.
      </p>
      <p className="text-xs mt-1.5 leading-relaxed" style={{ color: "var(--c-45)" }}>
        We&apos;re building free resources to help you streamline your
        production, reduce costs, and achieve more with less. Stay with us
        as we continue to grow into the one-stop solution you&apos;ve been
        looking for.
      </p>
    </div>
  );
}

interface KeyField {
  key: keyof FormState;
  label: string;
  description: string;
  placeholder: string;
  tier: Tier;
}

const KEY_FIELDS: KeyField[] = [
  {
    key: "kie_api_key",
    label: "KIE API Key",
    description: "Powers script generation & channel analysis, plus image and video generation through one provider.",
    placeholder: "kie-…",
    tier: "paid",
  },
  {
    key: "elevenlabs_api_key",
    label: "ElevenLabs API Key",
    description: "Powers TTS voiceovers (direct ElevenLabs call — fast per-beat synthesis at per-character pricing) and assembler speech-to-text alignment for captions.",
    placeholder: "sk_…",
    tier: "paid",
  },
  {
    key: "cloudflare_account_id",
    label: "Cloudflare Account ID",
    description: "Powers the Free image option (Cloudflare Workers AI · FLUX Schnell) on your own free daily quota. It's the long hex string in your Cloudflare dashboard URL — dash.cloudflare.com/<Account ID>. See the Instructions tab for the full walkthrough.",
    placeholder: "e.g. 1a2b3c4d5e6f7a8b9c0d…",
    tier: "free",
  },
  {
    key: "cloudflare_api_token",
    label: "Cloudflare API Token",
    description: "Goes with the Account ID above. Create it at dash.cloudflare.com → My Profile → API Tokens → Create Token, using the \"Workers AI\" template.",
    placeholder: "paste your Workers AI token",
    tier: "free",
  },
  {
    key: "google_tts_key",
    label: "Google Cloud TTS Key",
    description: "Powers the Free voiceover option (Google Cloud Text-to-Speech) — 1,000,000 characters/month free on your own account. Requires a Google Cloud project with billing enabled (you're not charged within the free tier) and the Text-to-Speech API turned on. See the Instructions tab.",
    placeholder: "AIza…",
    tier: "free",
  },
];

interface FormState {
  kie_api_key: string;
  elevenlabs_api_key: string;
  cloudflare_account_id: string;
  cloudflare_api_token: string;
  google_tts_key: string;
}

const EMPTY_FORM: FormState = {
  kie_api_key: "",
  elevenlabs_api_key: "",
  cloudflare_account_id: "",
  cloudflare_api_token: "",
  google_tts_key: "",
};

// One card per service: the walkthrough steps AND the key input(s)
// live together, so the user never bounces between an Instructions
// tab and a Setup tab to configure one provider.
interface ServiceCard {
  tier: Tier;
  title: string;
  sub: string;
  quota?: string;
  href?: string;
  linkLabel?: string;
  /** Included-with-account perk — green badge, no inputs. */
  perk?: boolean;
  steps: React.ReactNode[];
  /** Key inputs rendered inside this card (looked up in KEY_FIELDS). */
  fields: (keyof FormState)[];
}

const SERVICES: ServiceCard[] = [
  {
    tier: "paid",
    title: "Kie AI",
    sub: "Script generation, channel analysis, images & video clips",
    href: "https://kie.ai",
    linkLabel: "kie.ai",
    steps: [
      <>Create your account at <ExtLink href="https://kie.ai">kie.ai</ExtLink> — sign in with Google or email.</>,
      <>Open your <ExtLink href="https://kie.ai/api-key">API Key page</ExtLink> → <b>Create New API Key</b> → copy it right away (it&apos;s shown only once).</>,
      <>Add credits on the <ExtLink href="https://kie.ai/billing">Billing page</ExtLink> — credits pay for scripts, channel analysis, images, and video clips.</>,
      <>Paste the key below and hit <b>Save</b>.</>,
    ],
    fields: ["kie_api_key"],
  },
  {
    tier: "paid",
    title: "ElevenLabs",
    sub: "Voiceover synthesis and caption-alignment STT",
    href: "https://elevenlabs.io/app/settings/api-keys",
    linkLabel: "elevenlabs.io",
    steps: [
      <>Create your account at <ExtLink href="https://elevenlabs.io/app/sign-up">elevenlabs.io/app/sign-up</ExtLink>.</>,
      <>Open the <ExtLink href="https://elevenlabs.io/app/settings/api-keys">API Keys page</ExtLink> → <b>Create API Key</b> → make sure <b>Text to Speech</b> and <b>Speech to Text</b> permissions are enabled → copy the key right away (it&apos;s shown only once).</>,
      <>Pick a plan on the <ExtLink href="https://elevenlabs.io/app/subscription">Subscription page</ExtLink> that covers your monthly character volume.</>,
      <>Optional: browse the <ExtLink href="https://elevenlabs.io/app/voice-library">Voice Library</ExtLink> and add voices to <b>My Voices</b> — they&apos;ll show up in the Voiceover step.</>,
      <>Paste the key below and hit <b>Save</b>.</>,
    ],
    fields: ["elevenlabs_api_key"],
  },
  {
    tier: "free",
    quota: "50k–100k chars/month",
    title: "Qwen Voices (Free voiceover — on us)",
    sub: "Included with every account — runs on Heclus's own infrastructure, nothing to connect",
    perk: true,
    steps: [
      <>
        <span className="block text-2xl font-bold" style={{ color: "var(--c-90)" }}>This is a perk 🎁</span>
        <span className="block mt-1 text-sm">Heclus bears the cost.</span>
        <span className="block" style={{ marginTop: "40px" }}>
          <span className="block text-xs font-semibold" style={{ color: "oklch(0.72 0.25 285)" }}>50k chrs/month for Starters</span>
          <span className="block text-xs font-semibold mt-1" style={{ color: "oklch(0.72 0.25 285)" }}>100k chrs/month for Pros</span>
        </span>
      </>,
    ],
    fields: [],
  },
  {
    tier: "free",
    quota: "500 imgs/month",
    title: "Cloudflare Workers AI (Free images)",
    sub: "Powers the Free image option — free daily quota on your own account (~500–2,000 images/day)",
    href: "https://dash.cloudflare.com",
    linkLabel: "dash.cloudflare.com",
    steps: [
      <>Create a free account at <ExtLink href="https://dash.cloudflare.com/sign-up">dash.cloudflare.com/sign-up</ExtLink> — no credit card needed.</>,
      <>Copy your <b>Account ID</b>: after you log in at <ExtLink href="https://dash.cloudflare.com">dash.cloudflare.com</ExtLink>, the address bar shows <span style={{ fontFamily: "monospace" }}>dash.cloudflare.com/&lt;Account ID&gt;</span> — copy that 32-character code.</>,
      <>Create an API token: open <ExtLink href="https://dash.cloudflare.com/profile/api-tokens">the API Tokens page</ExtLink> → <b>Create Token</b> → pick the <b>Workers AI</b> template → <b>Continue to summary</b> → <b>Create Token</b> → copy it.</>,
      <>Paste the Account ID and the token below and hit <b>Save</b>.</>,
    ],
    fields: ["cloudflare_account_id", "cloudflare_api_token"],
  },
  {
    tier: "free",
    quota: "1M chars/month",
    title: "Google Cloud TTS (Free voiceover)",
    sub: "Powers the Free voiceover option — 1,000,000 characters/month free on your own account",
    href: "https://console.cloud.google.com",
    linkLabel: "console.cloud.google.com",
    steps: [
      <>Create a Google Cloud project at <ExtLink href="https://console.cloud.google.com/projectcreate">console.cloud.google.com/projectcreate</ExtLink> — any name works.</>,
      <>Enable billing for it at <ExtLink href="https://console.cloud.google.com/billing">console.cloud.google.com/billing</ExtLink>. Don&apos;t worry: the first 1M characters each month are free and never charged.</>,
      <>Turn on the Text-to-Speech API: open <ExtLink href="https://console.cloud.google.com/apis/library/texttospeech.googleapis.com">this page</ExtLink> and click <b>Enable</b>.</>,
      <>Create your key: open the <ExtLink href="https://console.cloud.google.com/apis/credentials">Credentials page</ExtLink> → <b>+ Create credentials</b> → <b>API key</b> → copy it.</>,
      <>Paste the key below and hit <b>Save</b>.</>,
    ],
    fields: ["google_tts_key"],
  },
];

function AddUserSection() {
  const [email, setEmail] = useState("");
  const [adding, setAdding] = useState(false);

  async function handleAddUser(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    try {
      const res = await fetch("/api/auth/add-user", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to add user");
      toast.success(`Access granted to ${email}. Send them /signup to create their account.`);
      setEmail("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add user");
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: "oklch(0.55 0.15 145 / 0.12)", border: "1px solid oklch(0.55 0.15 145 / 0.25)" }}>
          <UserPlus size={18} style={{ color: "oklch(0.65 0.15 145)" }} />
        </div>
        <div>
          <h2 className="text-lg font-bold text-foreground">Add User</h2>
          <p className="text-xs" style={{ color: "var(--c-45)" }}>
            Grant access to an email address, then send them{" "}
            <code style={{ color: "var(--c-60)" }}>/signup</code> to create their account.
          </p>
        </div>
      </div>

      <form onSubmit={handleAddUser} className="p-5 rounded-2xl space-y-3"
        style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" }}>
        <label className="text-xs font-medium" style={{ color: "var(--c-50)" }}>Email address</label>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="user@example.com"
            className="flex-1 px-3 py-2.5 rounded-lg text-sm outline-none transition-all"
            style={{ background: "var(--bg-input)", border: "1px solid var(--bd-10)", color: "var(--c-90)" }}
            onFocus={(e) => { e.currentTarget.style.borderColor = "oklch(0.72 0.25 285 / 0.5)"; }}
            onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-10)"; }}
          />
          <button
            type="submit"
            disabled={adding}
            className="px-4 py-2.5 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 flex items-center gap-2"
            style={{ background: "oklch(0.55 0.15 145)", color: "oklch(0.08 0 0)" }}
          >
            <UserPlus size={14} />
            {adding ? "Adding…" : "Add User"}
          </button>
        </div>
      </form>
    </div>
  );
}

// Account-level character-consistency default. A single statement
// appended to EVERY image prompt across all projects (each project can
// still override or detach it in its Prompts step). Free text, not a
// secret — persisted (including when cleared to empty) via /api/settings.
function CharacterConsistencyDefaults() {
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setText((data?.character_consistency_text as string) ?? "");
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ character_consistency_text: text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      toast.success("Character consistency default saved.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save default");
    } finally {
      setSaving(false);
    }
  }

  const inputStyle = { background: "var(--bg-input)", border: "1px solid var(--bd-10)", color: "var(--c-90)" } as const;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
          <Users size={18} style={{ color: "oklch(0.72 0.25 285)" }} />
        </div>
        <div>
          <h2 className="text-lg font-bold text-foreground">Character Consistency</h2>
          <p className="text-xs" style={{ color: "var(--c-45)" }}>
            A reusable statement added to <b>every</b> image prompt to keep your
            character and style the same. Applies to all projects. Each project
            can change or turn it off in its Prompts step.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-4" style={{ color: "var(--c-40)" }}>
          <Spinner size={16} />
          <span className="text-sm">Loading…</span>
        </div>
      ) : (
        <div className="p-5 rounded-2xl space-y-4"
          style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" }}>
          <div className="space-y-2">
            <label className="text-xs font-medium" style={{ color: "var(--c-50)" }}>
              Consistency text
            </label>
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              placeholder="e.g. Recurring character: a 30-year-old woman, red curly hair, green parka. Flat 2D illustration style, warm palette. Keep her face, hairstyle and outfit identical across every image."
              className="w-full px-3 py-2.5 rounded-lg text-sm outline-none transition-all resize-y"
              style={inputStyle}
              onFocus={(e) => { e.currentTarget.style.borderColor = "oklch(0.72 0.25 285 / 0.5)"; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = "var(--bd-10)"; }}
            />
          </div>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
            style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
          >
            {saving ? <Spinner size={14} /> : <Save size={14} />}
            {saving ? "Saving…" : "Save Default"}
          </button>
        </div>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  async function handleSignOut() {
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signOut();
    router.push("/login");
  }
  const [masked, setMasked] = useState<FormState>(EMPTY_FORM);
  const [visible, setVisible] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [tab, setTab] = useState<Tier>("paid");
  // Top-level split: API keys (the existing paid/free cards) vs the
  // full-page 1Click preference editor. Deep-linkable via
  // /setup?tab=oneclick (read from location to avoid the
  // useSearchParams/Suspense dance on this client page).
  const [mainTab, setMainTab] = useState<"keys" | "oneclick">("keys");
  useEffect(() => {
    if (typeof window !== "undefined" && new URLSearchParams(window.location.search).get("tab") === "oneclick") {
      setMainTab("oneclick");
    }
  }, []);
  const [userEmail, setUserEmail] = useState("");
  const [showProfileMenu, setShowProfileMenu] = useState(false);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getUser().then(({ data }) => {
      if (!data.user) {
        router.replace("/login");
        return;
      }
      if (data.user.email) setUserEmail(data.user.email);
      if (data.user.email === "prioritylearn@gmail.com") {
        setIsAdmin(true);
      }
    });
  }, [router]);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        setMasked(data as FormState);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function toggle(key: string) {
    setVisible((v) => ({ ...v, [key]: !v[key] }));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    console.log("[setup] handleSave fired. form =", {
      kie_api_key_len: form.kie_api_key.length,
      elevenlabs_api_key_len: form.elevenlabs_api_key.length,
      kie_api_key_trimmed_len: form.kie_api_key.trim().length,
      elevenlabs_api_key_trimmed_len: form.elevenlabs_api_key.trim().length,
    });
    const payload: Partial<FormState> = {};
    for (const field of KEY_FIELDS) {
      const val = form[field.key].trim();
      if (val) (payload as Record<string, string>)[field.key] = val;
    }
    console.log("[setup] payload keys =", Object.keys(payload));
    if (Object.keys(payload).length === 0) {
      console.log("[setup] bailing — empty payload, no fetch will fire");
      toast.error("Enter at least one API key to save.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Save failed");
      toast.success("API keys saved successfully.");
      setForm(EMPTY_FORM);
      const fresh = await fetch("/api/settings").then((r) => r.json());
      setMasked(fresh as FormState);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save settings");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col" style={{ background: "var(--bg-page)" }}>
      {/* Header */}
      <header className="flex items-center justify-between px-4 sm:px-8 py-4 sticky top-0 z-10"
        style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header)", backdropFilter: "blur(16px)" }}>
        <Link href="/dashboard" className="flex items-center gap-3 min-w-0 transition-opacity hover:opacity-80">
          <div className="w-8 h-8 shrink-0 rounded-xl flex items-center justify-center">
            <Image src="/heclus-icon-white.svg" alt="Heclus" width={32} height={32} className="object-cover w-full h-full" />
          </div>
          <div className="min-w-0">
            <span className="font-bold text-sm tracking-tight text-foreground">Heclus</span>
            <span className="text-sm tracking-tight ml-1 hidden sm:inline" style={{ color: "var(--c-50)" }}>Settings</span>
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
                <div
                  className="absolute right-0 top-11 z-50 w-56 rounded-2xl py-3 shadow-2xl"
                  style={{ background: "var(--bg-card)", border: "1px solid oklch(1 0 0 / 0.1)" }}
                >
                  <div className="px-4 pb-3" style={{ borderBottom: "1px solid oklch(1 0 0 / 0.07)" }}>
                    <p className="text-xs font-semibold truncate" style={{ color: "var(--c-88)" }}>
                      {userEmail || "Loading…"}
                    </p>
                  </div>
                  <div className="px-2 pt-2">
                    <Link
                      href="/account"
                      onClick={() => setShowProfileMenu(false)}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-xs transition-all hover:opacity-80"
                      style={{ color: "var(--c-60)" }}
                    >
                      <KeyRound size={13} />
                      <span>Account</span>
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

        {/* Top-level tabs: API KEYS / 1CLICK */}
        <div className="flex gap-1 mb-6 p-1 rounded-xl w-full"
          style={{ background: "oklch(1 0 0 / 0.04)", border: "1px solid oklch(1 0 0 / 0.07)" }}>
          {([["keys", "API Keys"], ["oneclick", "1Click"]] as const).map(([id, label]) => (
            <button
              key={id}
              onClick={() => setMainTab(id)}
              className="flex-1 py-2 rounded-lg text-xs font-bold tracking-widest uppercase transition-all cursor-pointer"
              style={{
                background: mainTab === id ? "oklch(0.72 0.25 285)" : "transparent",
                color: mainTab === id ? "white" : "var(--c-45)",
              }}
            >
              {id === "oneclick" ? <span className="inline-flex items-center gap-1.5"><SlidersHorizontal size={12} /> {label}</span> : label}
            </button>
          ))}
        </div>

        {mainTab === "oneclick" ? (
          <OneClickConfigPanel />
        ) : (
        <>
        {/* Sub-tabs: PAID / FREE — same segmented style as the generate
            step's Images / Videos / Both switcher. */}
        <div className="flex items-center gap-1 rounded-xl p-1 mb-10"
          style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-card)" }}>
          {([
            { key: "paid" as const, label: "Paid", icon: <CreditCard size={15} /> },
            { key: "free" as const, label: "Free", icon: <Gift size={15} /> },
          ]).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              aria-pressed={tab === t.key}
              className="flex-1 py-2 rounded-lg text-sm font-semibold transition-all flex items-center justify-center gap-1.5 cursor-pointer"
              style={tab === t.key
                ? { background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.88 0.12 285)" }
                : { color: "var(--c-55)" }}
            >
              {t.icon}
              {t.key === "free" && FREE_TIER_COMING_SOON ? (
                <span className="flex flex-col items-center leading-tight">
                  <span>Free</span>
                  <span className="text-[9px] font-semibold normal-case tracking-normal">coming soon</span>
                </span>
              ) : t.label}
            </button>
          ))}
        </div>

        <div className="space-y-8">
          {/* Page heading */}
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                style={{ background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
                <Settings size={18} style={{ color: "oklch(0.72 0.25 285)" }} />
              </div>
              <h1 className="text-2xl font-bold text-foreground">API Keys</h1>
            </div>
            <p className="text-sm leading-relaxed" style={{ color: "var(--c-50)" }}>
              Each card walks you through one service and takes its keys right there — takes ~5 minutes.
              Keys are saved securely and take effect immediately.
            </p>
          </div>

          {tab === "free" && FREE_TIER_COMING_SOON ? (
            <FreeComingSoonCard />
          ) : loading ? (
            <div className="flex items-center gap-2 py-6" style={{ color: "var(--c-40)" }}>
              <Spinner size={16} />
              <span className="text-sm">Loading settings…</span>
            </div>
          ) : (
            <form onSubmit={handleSave} className="space-y-6">
              {/* items-start keeps cards their natural height instead of
                  stretching to the tallest sibling in the row. */}
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 items-start">
                {SERVICES.filter((svc) => svc.tier === tab).map((svc, idx) => (
                  <div key={svc.title} className="p-5 rounded-2xl space-y-4"
                    style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid white" }}>
                    {/* Card header */}
                    <div className="flex items-start gap-3">
                      <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 text-xs font-bold"
                        style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.72 0.25 285)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}>
                        {idx + 1}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-foreground">{svc.title}</p>
                        <p className="text-xs" style={{ color: "var(--c-40)" }}>{svc.sub}</p>
                        {svc.quota && (
                          <p className="text-xs font-semibold mt-0.5"
                            style={{ color: "oklch(0.72 0.25 285)", ...(svc.perk ? { marginBottom: "40px" } : {}) }}>
                            {svc.quota}
                          </p>
                        )}
                      </div>
                      {svc.href && (
                        <a href={svc.href} target="_blank" rel="noopener noreferrer"
                          className="ml-auto text-xs shrink-0 hover:opacity-80"
                          style={{ color: "oklch(0.72 0.25 285)", textDecoration: "underline" }}>
                          {svc.linkLabel} ↗
                        </a>
                      )}
                    </div>

                    {svc.perk && (
                      <span className="mx-auto w-fit flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium"
                        style={{
                          background: "oklch(0.55 0.15 145 / 0.15)",
                          color: "oklch(0.65 0.15 145)",
                          border: "1px solid oklch(0.55 0.15 145 / 0.3)",
                        }}>
                        <CheckCircle2 size={10} />
                        Included — no setup needed
                      </span>
                    )}

                    {/* Instructions — a single-step card (e.g. the Qwen
                        perk) reads as a centered statement, not a
                        numbered list. */}
                    {svc.steps.length === 1 ? (
                      <p className="text-xs leading-relaxed text-center" style={{ color: "var(--c-55)" }}>{svc.steps[0]}</p>
                    ) : (
                      <ol className="space-y-2.5 pl-9">
                        {svc.steps.map((s, i) => (
                          <li key={i} className="text-xs leading-relaxed" style={{ color: "var(--c-55)" }}>
                            <span className="font-medium" style={{ color: "var(--c-40)" }}>{i + 1}.</span> {s}
                          </li>
                        ))}
                      </ol>
                    )}

                    {/* Key inputs for this service */}
                    {svc.fields.map((key) => {
                      const field = KEY_FIELDS.find((f) => f.key === key)!;
                      const currentMasked = masked[field.key] ?? "";
                      const isSet = !!currentMasked;
                      const isShowing = visible[field.key];

                      return (
                        <div key={field.key} className="space-y-2 pt-3"
                          style={{ borderTop: "1px solid oklch(1 0 0 / 0.07)" }}>
                          <div className="flex items-center gap-2">
                            <label className="text-sm font-semibold text-foreground">{field.label}</label>
                            {isSet && (
                              <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium"
                                style={{
                                  background: "oklch(0.55 0.15 145 / 0.15)",
                                  color: "oklch(0.65 0.15 145)",
                                  border: "1px solid oklch(0.55 0.15 145 / 0.3)",
                                }}>
                                <CheckCircle2 size={10} />
                                Configured
                              </span>
                            )}
                          </div>

                          {isSet && (
                            <div className="text-xs font-mono px-3 py-2 rounded-lg"
                              style={{ background: "var(--bg-code)", color: "var(--c-40)", border: "1px solid var(--bd-5)" }}>
                              Current: {currentMasked}
                            </div>
                          )}

                          <div className="relative">
                            <input
                              type={isShowing ? "text" : "password"}
                              name={field.key}
                              autoComplete="new-password"
                              spellCheck={false}
                              value={form[field.key]}
                              onChange={(e) => {
                                console.log(`[setup] input onChange field=${field.key} valueLen=${e.target.value.length}`);
                                setForm((f) => ({ ...f, [field.key]: e.target.value }));
                              }}
                              placeholder={isSet ? "Enter new value to replace…" : field.placeholder}
                              className="w-full pr-10 px-3 py-2.5 rounded-xl text-sm font-mono outline-none transition-all"
                              style={{ background: "var(--bg-input)", border: "1px solid var(--bd-10)", color: "var(--c-88)" }}
                              onFocus={(e) => { (e.target as HTMLInputElement).style.borderColor = "oklch(0.72 0.25 285 / 0.5)"; }}
                              onBlur={(e) => { (e.target as HTMLInputElement).style.borderColor = "var(--bd-10)"; }}
                            />
                            <button type="button" tabIndex={-1} onClick={() => toggle(field.key)}
                              className="absolute right-3 top-1/2 -translate-y-1/2 transition-opacity hover:opacity-70"
                              style={{ color: "var(--c-40)" }}>
                              {isShowing ? <EyeOff size={14} /> : <Eye size={14} />}
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>

              <button
                type="submit"
                disabled={saving || Object.values(form).every((v) => !v.trim())}
                onClick={() => console.log("[setup] Save button onClick fired. disabled flag =", saving || Object.values(form).every((v) => !v.trim()), "form =", { kie_len: form.kie_api_key.length, el_len: form.elevenlabs_api_key.length })}
                className="w-full sm:w-auto sm:min-w-[240px] flex items-center justify-center gap-2 px-6 py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
                style={{
                  background: "linear-gradient(135deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))",
                  color: "var(--c-98)",
                  boxShadow: "0 0 24px oklch(0.72 0.25 285 / 0.25)",
                }}>
                {saving ? <Spinner size={15} /> : <Save size={15} />}
                {saving ? "Saving…" : "Save API Keys"}
              </button>
            </form>
          )}

          {/* Character-consistency defaults — applies to every project's
              image prompts unless overridden per project. */}
          <CharacterConsistencyDefaults />

          {/* Add User — admin only */}
          {isAdmin && <AddUserSection />}
        </div>
        </>
        )}

      </main>
    </div>
  );
}
