"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Settings, Eye, EyeOff, ArrowLeft, Save, CheckCircle2, LogOut, UserPlus, BookOpen } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import { ThemeToggle } from "@/components/ThemeToggle";
import Image from "next/image";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

interface KeyField {
  key: keyof FormState;
  label: string;
  description: string;
  placeholder: string;
}

const KEY_FIELDS: KeyField[] = [
  {
    key: "anthropic_api_key",
    label: "Anthropic API Key",
    description: "Used for Claude AI — script generation, channel analysis, and prompt creation",
    placeholder: "sk-ant-api03-…",
  },
  {
    key: "kie_api_key",
    label: "KIE API Key",
    description: "Used for TTS voiceover, AI image generation, and video clip generation",
    placeholder: "kie-…",
  },
  {
    key: "elevenlabs_api_key",
    label: "ElevenLabs API Key",
    description: "Used for voiceover transcription and caption timing alignment",
    placeholder: "sk_…",
  },
];

interface FormState {
  anthropic_api_key: string;
  kie_api_key: string;
  elevenlabs_api_key: string;
}

const EMPTY_FORM: FormState = {
  anthropic_api_key: "",
  kie_api_key: "",
  elevenlabs_api_key: "",
};

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
  const [tab, setTab] = useState<"setup" | "instructions">("instructions");
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
        const anyConfigured = Object.values(data as FormState).some(Boolean);
        setTab(anyConfigured ? "setup" : "instructions");
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  function toggle(key: string) {
    setVisible((v) => ({ ...v, [key]: !v[key] }));
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const payload: Partial<FormState> = {};
    for (const field of KEY_FIELDS) {
      const val = form[field.key].trim();
      if (val) (payload as Record<string, string>)[field.key] = val;
    }
    if (Object.keys(payload).length === 0) {
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
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 shrink-0 rounded-xl flex items-center justify-center">
            <Image src="/heclus-icon-white.svg" alt="Heclus" width={32} height={32} className="object-cover w-full h-full" />
          </div>
          <div className="min-w-0">
            <span className="font-bold text-sm tracking-tight text-foreground">Heclus</span>
            <span className="text-sm tracking-tight ml-1 hidden sm:inline" style={{ color: "var(--c-50)" }}>Settings</span>
          </div>
        </div>
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

        {/* Tabs */}
        <div className="flex gap-1 mb-10 p-1 rounded-xl"
          style={{ background: "oklch(1 0 0 / 0.04)", border: "1px solid oklch(1 0 0 / 0.07)" }}>
          {(["instructions", "setup"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className="flex-1 py-2 rounded-lg text-xs font-bold tracking-widest uppercase transition-all cursor-pointer"
              style={{
                background: tab === t ? "oklch(0.72 0.25 285)" : "transparent",
                color: tab === t ? "white" : "var(--c-45)",
              }}
            >
              {t}
            </button>
          ))}
        </div>

        {/* SETUP tab */}
        {tab === "setup" && (
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
                Enter your API keys below. They are saved securely and take effect immediately.
              </p>
            </div>

            {/* Form */}
            {loading ? (
              <div className="flex items-center gap-2 py-6" style={{ color: "var(--c-40)" }}>
                <Spinner size={16} />
                <span className="text-sm">Loading settings…</span>
              </div>
            ) : (
              <form onSubmit={handleSave} className="space-y-4">
                {KEY_FIELDS.map((field) => {
                  const currentMasked = masked[field.key] ?? "";
                  const isSet = !!currentMasked;
                  const isShowing = visible[field.key];

                  return (
                    <div key={field.key} className="p-5 rounded-2xl space-y-3"
                      style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" }}>
                      <div>
                        <div className="flex items-center gap-2 mb-1">
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
                        <p className="text-xs" style={{ color: "var(--c-45)" }}>{field.description}</p>
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
                          onChange={(e) => setForm((f) => ({ ...f, [field.key]: e.target.value }))}
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

                <button
                  type="submit"
                  disabled={saving || Object.values(form).every((v) => !v.trim())}
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
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

            {/* Info note */}
            {/* Add User — admin only */}
            {isAdmin && <AddUserSection />}
          </div>
        )}

        {/* INSTRUCTIONS tab */}
        {tab === "instructions" && (
          <div className="space-y-5">
            <div>
              <h1 className="text-xl font-bold text-foreground">Setup Guide</h1>
              <p className="text-xs mt-1" style={{ color: "var(--c-45)" }}>Add your API keys once — takes ~5 minutes.</p>
            </div>

            {[
              {
                num: 1,
                title: "Anthropic API Key",
                sub: "Claude AI · scripts & analysis",
                href: "https://console.anthropic.com",
                linkLabel: "console.anthropic.com",
                steps: [
                  "Sign in and go to API Keys.",
                  "Click Create Key, name it anything, copy it.",
                  <>Top up billing with ~$5 — you&apos;re only charged per request.</>,
                ],
              },
              {
                num: 2,
                title: "Kie AI API Key",
                sub: "Voiceovers, images & video clips",
                href: "https://kie.ai",
                linkLabel: "kie.ai",
                steps: [
                  "Sign in and go to API Keys.",
                  "Create a key, name it, copy it.",
                  "Top up credits as needed.",
                ],
              },
              {
                num: 3,
                title: "ElevenLabs API Key",
                sub: "Caption timing & assembly",
                href: "https://elevenlabs.io",
                linkLabel: "elevenlabs.io",
                steps: [
                  "Go to Developers → API Keys.",
                  "Copy the default developer key (free tier is fine).",
                ],
              },
            ].map(({ num, title, sub, href, linkLabel, steps }) => (
              <div key={num} className="p-4 rounded-2xl space-y-3" style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.07)" }}>
                <div className="flex items-center gap-3">
                  <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 text-xs font-bold"
                    style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.72 0.25 285)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}>{num}</div>
                  <div>
                    <p className="text-sm font-semibold text-foreground">{title}</p>
                    <p className="text-xs" style={{ color: "var(--c-40)" }}>{sub}</p>
                  </div>
                  <a href={href} target="_blank" rel="noopener noreferrer"
                    className="ml-auto text-xs shrink-0 hover:opacity-80"
                    style={{ color: "oklch(0.72 0.25 285)", textDecoration: "underline" }}>
                    {linkLabel} ↗
                  </a>
                </div>
                <ol className="space-y-1 pl-9">
                  {steps.map((s, i) => (
                    <li key={i} className="text-xs leading-relaxed" style={{ color: "var(--c-55)" }}>
                      <span className="font-medium" style={{ color: "var(--c-40)" }}>{i + 1}.</span> {s}
                    </li>
                  ))}
                </ol>
              </div>
            ))}

            <div className="flex justify-end pt-1">
              <button
                onClick={() => setTab("setup")}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold transition-all hover:opacity-90"
                style={{ background: "linear-gradient(135deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))", color: "var(--c-98)" }}>
                <ArrowLeft size={14} style={{ transform: "rotate(180deg)" }} />
                Go to Setup
              </button>
            </div>
          </div>
        )}

      </main>
    </div>
  );
}
