"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Settings, Eye, EyeOff, ArrowLeft, Save, CheckCircle2, LogOut, UserPlus } from "lucide-react";
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
    key: "youtube_api_key",
    label: "YouTube API Key",
    description: "Used for channel lookup and video metadata via the YouTube Data API v3",
    placeholder: "AIzaSy…",
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
  youtube_api_key: string;
  kie_api_key: string;
  elevenlabs_api_key: string;
}

const EMPTY_FORM: FormState = {
  anthropic_api_key: "",
  youtube_api_key: "",
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
        style={{ background: "var(--bg-card)", border: "1px solid var(--bd-7)" }}>
        <label className="text-xs font-medium" style={{ color: "var(--c-50)" }}>Email address</label>
        <div className="flex gap-2">
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

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getUser().then(({ data }) => {
      if (data.user?.email === "prioritylearn@gmail.com") setIsAdmin(true);
    });
  }, []);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => setMasked(data as FormState))
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
      <header className="flex items-center justify-between px-8 py-4 sticky top-0 z-10"
        style={{ borderBottom: "1px solid var(--bd-6)", background: "var(--bg-header)", backdropFilter: "blur(16px)" }}>
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 shrink-0 rounded-full overflow-hidden flex items-center justify-center">
            <Image src="/logo.png" alt="aiTrends" width={32} height={32} className="object-cover w-full h-full" />
          </div>
          <div>
            <span className="font-bold text-sm tracking-tight text-foreground">aiTrends</span>
            <span className="text-sm tracking-tight ml-1" style={{ color: "var(--c-50)" }}>Settings</span>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={handleSignOut}
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-all hover:opacity-80"
            style={{ background: "var(--bg-control)", color: "var(--c-55)", border: "1px solid var(--bd-8)" }}
          >
            <LogOut size={15} />
            <span>Sign Out</span>
          </button>
          <ThemeToggle />
          <button
            onClick={() => router.push("/")}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all hover:opacity-80"
            style={{ background: "var(--bg-control)", color: "var(--c-60)", border: "1px solid var(--bd-8)" }}>
            <ArrowLeft size={14} />
            Back to Home
          </button>
        </div>
      </header>

      <main className="flex-1 w-full max-w-2xl mx-auto px-8 py-14 space-y-8">
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
            Configure your API keys here. They are stored in your Supabase database and override any values in{" "}
            <code className="text-xs px-1.5 py-0.5 rounded font-mono"
              style={{ background: "var(--bg-control)", color: "oklch(0.7 0.15 285)" }}>
              .env.local
            </code>.
            Leave a field blank to keep the existing value.
          </p>
        </div>

        {/* Form */}
        {loading ? (
          <div className="text-sm" style={{ color: "var(--c-40)" }}>Loading…</div>
        ) : (
          <form onSubmit={handleSave} className="space-y-4">
            {KEY_FIELDS.map((field) => {
              const currentMasked = masked[field.key] ?? "";
              const isSet = !!currentMasked;
              const isShowing = visible[field.key];

              return (
                <div key={field.key} className="p-5 rounded-2xl space-y-3"
                  style={{ background: "var(--bg-card)", border: "1px solid var(--bd-7)" }}>
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
              disabled={saving}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
              style={{
                background: "linear-gradient(135deg, oklch(0.72 0.25 285), oklch(0.58 0.28 300))",
                color: "var(--c-98)",
                boxShadow: "0 0 24px oklch(0.72 0.25 285 / 0.25)",
              }}>
              <Save size={15} />
              {saving ? "Saving…" : "Save API Keys"}
            </button>
          </form>
        )}

        {/* Info note */}
        <div className="px-4 py-3 rounded-xl text-xs leading-relaxed"
          style={{ background: "oklch(0.72 0.25 285 / 0.06)", border: "1px solid oklch(0.72 0.25 285 / 0.15)", color: "var(--c-50)" }}>
          Keys saved here take effect immediately. If a key is blank in the database, the app falls back to{" "}
          <code style={{ color: "var(--c-60)" }}>.env.local</code>.
          Your Supabase URL and Redis credentials must remain in <code style={{ color: "var(--c-60)" }}>.env.local</code> to bootstrap the app.
        </div>

        {/* Add User — admin only */}
        {isAdmin && <AddUserSection />}
      </main>
    </div>
  );
}
