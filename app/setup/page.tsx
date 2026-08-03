"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Settings, Eye, EyeOff, ArrowLeft, Save, CheckCircle2, LogOut, UserPlus, BookOpen, KeyRound, CreditCard, Gift, Brain, Wand2, Pilcrow } from "lucide-react";
import { OneClickConfigPanel } from "@/components/one-click/OneClickConfigPanel";
import { Spinner } from "@/components/ui/spinner";
import { ThemeToggle } from "@/components/ThemeToggle";
import Image from "next/image";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { FREE_TTS_COMING_SOON } from "@/lib/free-tier-flag";

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
];

interface FormState {
  kie_api_key: string;
  elevenlabs_api_key: string;
}

const EMPTY_FORM: FormState = {
  kie_api_key: "",
  elevenlabs_api_key: "",
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
    title: "Free Voices (Free voiceover — on us)",
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

// Account-level Claude model choice for the prompt-generation steps.
// Only rendered when an admin has allowlisted models (Config → Anthropic →
// Model) — the GET returns an empty options array otherwise and the whole
// panel hides rather than showing an empty picker.
interface ClaudeModelChoice {
  id: string;
  label: string;
  note: string;
  tierLabel: string;
}

function ClaudeModelDefault() {
  const [options, setOptions] = useState<ClaudeModelChoice[]>([]);
  const [selected, setSelected] = useState("");
  const [isPro, setIsPro] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/me/claude-model")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        setOptions((d.options as ClaudeModelChoice[]) ?? []);
        setSelected((d.selected as string) ?? "");
        setIsPro(d.isPro === true);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // `null` = the account default. Saves immediately: one click, one field,
  // nothing to batch behind a Save button.
  async function pick(model: string | null) {
    if (!isPro) return;
    setSaving(model ?? "__default__");
    try {
      const res = await fetch("/api/me/claude-model", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "Save failed");
      setSelected(model ?? "");
      toast.success(model ? "Model updated." : "Using the account default.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save model");
    } finally {
      setSaving(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-6" style={{ color: "var(--c-40)" }}>
        <Spinner size={16} />
        <span className="text-sm">Loading…</span>
      </div>
    );
  }

  const rows: { key: string; value: string | null; title: string; note: string }[] = [
    {
      key: "__default__",
      value: null,
      title: "Account default",
      note: "Whatever Heclus has tuned as the best all-round choice. Recommended.",
    },
    ...options.map((o) => ({
      key: o.id,
      value: o.id as string | null,
      title: `${o.tierLabel} — ${o.label}`,
      note: o.note,
    })),
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
          style={{ background: "oklch(0.72 0.25 285 / 0.12)", border: "1px solid oklch(0.72 0.25 285 / 0.25)" }}>
          <Brain size={18} style={{ color: "oklch(0.72 0.25 285)" }} />
        </div>
        <div>
          <h2 className="text-lg font-bold text-foreground">Claude Model</h2>
          <p className="text-xs" style={{ color: "var(--c-45)" }}>
            Which Claude model writes your image, video, and thumbnail prompts. Faster
            models cost you fewer KIE credits per run; stronger ones follow a
            brief more closely.
          </p>
        </div>
      </div>

      {/* No allowlisted models = nobody can choose yet. Say so plainly
          rather than rendering a picker with a single inert row. */}
      {options.length === 0 ? (
        <div className="p-4 rounded-xl text-xs leading-relaxed"
          style={{ background: "var(--bg-input)", border: "1px solid var(--bd-card)", color: "var(--c-55)" }}>
          <p className="text-sm font-semibold text-foreground mb-1.5">
            Not available yet
          </p>
          Choosing your own prompt model hasn&apos;t been switched on. Every run
          currently uses the model Heclus has tuned as the best all-round
          choice — nothing is missing from your generations, and there&apos;s
          nothing you need to do here.
        </div>
      ) : !isPro && (
        <div className="p-3 rounded-xl text-xs leading-relaxed"
          style={{ background: "oklch(0.72 0.25 285 / 0.08)", border: "1px solid oklch(0.72 0.25 285 / 0.25)", color: "var(--c-70)" }}>
          Choosing your own model is a <b>Pro</b> feature. Your runs use the
          account default in the meantime.
        </div>
      )}

      <div className={options.length === 0 ? "hidden" : "space-y-2"}>
        {rows.map((r) => {
          const on = (r.value ?? "") === selected;
          const busy = saving === r.key;
          return (
            <button
              key={r.key}
              onClick={() => pick(r.value)}
              disabled={!isPro || saving !== null}
              className="w-full text-left p-3 rounded-xl transition-all cursor-pointer disabled:cursor-not-allowed flex items-start gap-3"
              style={{
                background: on ? "oklch(0.72 0.25 285 / 0.1)" : "oklch(1 0 0 / 0.04)",
                border: `1px solid ${on ? "oklch(0.72 0.25 285 / 0.45)" : "var(--bd-card)"}`,
                opacity: !isPro && !on ? 0.55 : 1,
              }}
            >
              <span className="mt-0.5 shrink-0">
                {busy ? <Spinner size={14} /> : (
                  <span className="w-3.5 h-3.5 rounded-full block"
                    style={{
                      border: `1px solid ${on ? "oklch(0.72 0.25 285)" : "var(--bd-10)"}`,
                      background: on ? "oklch(0.72 0.25 285)" : "transparent",
                    }} />
                )}
              </span>
              <span className="min-w-0">
                <span className="text-sm font-semibold text-foreground">{r.title}</span>
                <span className="block text-xs mt-0.5 leading-relaxed" style={{ color: "var(--c-45)" }}>
                  {r.note}
                </span>
              </span>
            </button>
          );
        })}
      </div>

      {options.length > 0 && (
        <p className="text-[11px] leading-relaxed" style={{ color: "var(--c-40)" }}>
          Channel analysis and script generation always run on the account default —
          those set up everything downstream, so we keep them on the model tuned for them.
        </p>
      )}
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
  // True when the field was prefilled from a project rather than from a
  // saved account default — the value is real but not yet global.
  const [fromProject, setFromProject] = useState(false);

  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        const saved = (data?.character_consistency_text as string) ?? "";
        const suggestion = (data?.character_consistency_suggestion as string) ?? "";
        if (saved.trim()) {
          setText(saved);
        } else if (suggestion) {
          setText(suggestion);
          setFromProject(true);
        }
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
      // It's the account default now, so the "came from a project" hint no
      // longer applies.
      setFromProject(false);
      toast.success("Prompt prefix default saved.");
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
          <Pilcrow size={18} style={{ color: "oklch(0.72 0.25 285)" }} />
        </div>
        <div>
          <h2 className="text-lg font-bold text-foreground">Prompt Prefix</h2>
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
            {fromProject && (
              <p className="text-[11px] leading-relaxed" style={{ color: "oklch(0.72 0.25 285)" }}>
                Filled in from the last prefix you set on a project. Save it to
                make it your default for every new project.
              </p>
            )}
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
  // Top-level split: API keys (the existing paid/free cards), the
  // full-page 1Click preference editor, and the account-level
  // Character Consistency default. Deep-linkable via
  // /setup?tab=oneclick or /setup?tab=consistency (read from location
  // to avoid the useSearchParams/Suspense dance on this client page).
  const [mainTab, setMainTab] = useState<"keys" | "oneclick" | "consistency" | "model">("keys");
  useEffect(() => {
    if (typeof window === "undefined") return;
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t === "oneclick" || t === "consistency" || t === "model") setMainTab(t);
  }, []);

  // Claude tab is Pro-only. null = not yet known, so the tab stays hidden
  // and a ?tab=model deep link isn't bounced before the answer arrives.
  // /api/me/claude-model is the same isProTier check the server enforces.
  const [isPro, setIsPro] = useState<boolean | null>(null);
  useEffect(() => {
    fetch("/api/me/claude-model")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setIsPro(d?.isPro === true))
      .catch(() => setIsPro(false));
  }, []);
  useEffect(() => {
    if (isPro === false && mainTab === "model") setMainTab("keys");
  }, [isPro, mainTab]);
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

        {/* Top-level tabs: API KEYS / 1CLICK / CHARACTER CONSISTENCY */}
        <div className="flex gap-1 mb-6 p-1 rounded-xl w-full"
          style={{ background: "oklch(1 0 0 / 0.04)", border: "1px solid oklch(1 0 0 / 0.07)" }}>
          {([["keys", "API Keys"], ["oneclick", "1Click"], ["consistency", "Prompt Prefix"], ["model", "Claude"]] as const)
            .filter(([id]) => id !== "model" || isPro === true)
            .map(([id, label]) => (
            <button
              key={id}
              onClick={() => setMainTab(id)}
              className="flex-1 py-2 rounded-lg text-xs font-bold tracking-widest uppercase transition-all cursor-pointer"
              style={{
                background: mainTab === id ? "oklch(0.72 0.25 285)" : "transparent",
                color: mainTab === id ? "white" : "var(--c-45)",
              }}
            >
              {id === "oneclick" ? (
                // Wand2 — matches the 1Click workflow shell/controls.
                <span className="inline-flex items-center gap-1.5"><Wand2 size={12} /> {label}</span>
              ) : id === "consistency" ? (
                <span className="inline-flex items-center gap-1.5"><Pilcrow size={12} /> {label}</span>
              ) : id === "model" ? (
                <span className="inline-flex items-center gap-1.5"><Brain size={12} /> {label}</span>
              ) : label}
            </button>
          ))}
        </div>

        {mainTab === "oneclick" ? (
          <OneClickConfigPanel />
        ) : mainTab === "consistency" ? (
          <div className="w-full max-w-2xl mx-auto">
            <CharacterConsistencyDefaults />
          </div>
        ) : mainTab === "model" ? (
          <div className="w-full max-w-2xl mx-auto">
            <ClaudeModelDefault />
          </div>
        ) : (
        <>
        {/* Sub-tabs: PAID / FREE. Sized to content and left-aligned — a
            two-option switcher stretched full-width read like a primary
            nav rather than a filter on the cards below. */}
        <div className="inline-flex items-center gap-1 rounded-lg p-0.5 mb-8 w-fit"
          style={{ background: "var(--bg-progress)", border: "1px solid var(--bd-card)" }}>
          {([
            { key: "paid" as const, label: "Paid", icon: <CreditCard size={13} /> },
            { key: "free" as const, label: "Free", icon: <Gift size={13} /> },
          ]).map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              aria-pressed={tab === t.key}
              className="px-3 py-1.5 rounded-md text-xs font-semibold transition-all flex items-center justify-center gap-1.5 cursor-pointer"
              style={tab === t.key
                ? { background: "oklch(0.72 0.25 285 / 0.15)", color: "oklch(0.88 0.12 285)" }
                : { color: "var(--c-55)" }}
            >
              {t.icon}
              {t.key === "free" && FREE_TTS_COMING_SOON ? (
                <span className="flex flex-col items-center leading-tight">
                  <span>Free</span>
                  <span className="text-[8px] font-semibold normal-case tracking-normal">coming soon</span>
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
              One card per service, with its keys right there. Saved securely and
              live immediately.
            </p>
          </div>

          {tab === "free" && FREE_TTS_COMING_SOON ? (
            <FreeComingSoonCard />
          ) : loading ? (
            <div className="flex items-center gap-2 py-6" style={{ color: "var(--c-40)" }}>
              <Spinner size={16} />
              <span className="text-sm">Loading settings…</span>
            </div>
          ) : (
            <form onSubmit={handleSave} className="space-y-6">
              {/* Cards stretch to the tallest sibling in the row; each is a
                  flex column so the key inputs sit flush at the bottom. */}
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {SERVICES.filter((svc) => svc.tier === tab).map((svc, idx) => (
                  <div key={svc.title} className="p-5 rounded-2xl flex flex-col gap-4"
                    style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.14)" }}>
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

                    {/* Key inputs for this service — mt-auto pins them to the
                        card's bottom edge so they align across the row. */}
                    <div className="mt-auto flex flex-col gap-4">
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

          {/* Add User — admin only */}
          {isAdmin && <AddUserSection />}
        </div>
        </>
        )}

      </main>
    </div>
  );
}
