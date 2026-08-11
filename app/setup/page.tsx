"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Settings, Eye, EyeOff, ArrowLeft, Save, CheckCircle2, LogOut, UserPlus, BookOpen, KeyRound, CreditCard, Gift, Brain, Wand2, Pilcrow } from "lucide-react";
import { OneClickConfigPanel } from "@/components/one-click/OneClickConfigPanel";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { ThemeToggle } from "@/components/ThemeToggle";
import Image from "next/image";
import Link from "next/link";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { FREE_TTS_COMING_SOON } from "@/lib/free-tier-flag";
import { ONE_CLICK_HIDDEN } from "@/lib/feature-flags";
import { PREFIX_MAX_CHARS, prefixTooLongMessage } from "@/lib/prefix-limit";

type Tier = "paid" | "free";

// Inline external link used across the Instructions steps — one style,
// always opens in a new tab, so every step can carry a direct link.
function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      style={{ color: "var(--brand-text)", textDecoration: "underline" }}>
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
      <p className="text-base font-bold" style={{ color: "var(--brand-text)" }}>
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
    description: "Powers TTS voiceovers (direct ElevenLabs call — fast per-beat synthesis at per-character pricing) and assembler speech-to-text alignment for captions. Must be the key itself, which starts with sk_, not the key ID the list shows.",
    placeholder: "sk_…",
    tier: "paid",
  },
  {
    key: "anthropic_api_key",
    label: "Anthropic API Key",
    description: "Optional. Runs the writing steps (scripts, analysis, prompts) straight on your Anthropic account instead of through KIE. Switch it on below once saved.",
    placeholder: "sk-ant-…",
    tier: "paid",
  },
];

interface FormState {
  kie_api_key: string;
  elevenlabs_api_key: string;
  anthropic_api_key: string;
}

const EMPTY_FORM: FormState = {
  kie_api_key: "",
  elevenlabs_api_key: "",
  anthropic_api_key: "",
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
  /** Extra control rendered under this card's inputs. */
  afterFields?: "anthropic-direct-toggle";
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
      <>Open the <ExtLink href="https://elevenlabs.io/app/settings/api-keys">API Keys page</ExtLink> → <b>Create API Key</b> → enable all four permissions Heclus uses: <b>Text to Speech</b> (voiceover), <b>Speech to Text</b> (caption alignment), <b>Voices: read</b> (so your own voices appear in the picker) and <b>User: read</b> (so your character balance shows on the dashboard).</>,
      <>Copy the key that begins with <b>sk_</b>. It is shown once: in the dialog that appears right after <b>Create API Key</b> or <b>Rotate</b>. The 64-character value listed beside each key on that page is the key <b>ID</b>, not the key, and ElevenLabs rejects it. No longer have the key? Hit <b>Rotate</b>, then copy the new one before closing the dialog.</>,
      <>Pick a plan on the <ExtLink href="https://elevenlabs.io/app/subscription">Subscription page</ExtLink> that covers your monthly character volume.</>,
      <>Optional: browse the <ExtLink href="https://elevenlabs.io/app/voice-library">Voice Library</ExtLink> and add voices to <b>My Voices</b> — they&apos;ll show up in the Voiceover step.</>,
      <>Paste the key below and hit <b>Save</b>.</>,
    ],
    fields: ["elevenlabs_api_key"],
  },
  {
    tier: "paid",
    title: "Anthropic (optional)",
    sub: "Run the writing steps on your own Claude account instead of through KIE",
    href: "https://console.anthropic.com/settings/keys",
    linkLabel: "console.anthropic.com",
    steps: [
      <>Only worth doing if you already have (or want) an Anthropic account. Leave this blank and everything runs on your KIE key as normal.</>,
      <>Create your account at <ExtLink href="https://console.anthropic.com">console.anthropic.com</ExtLink>.</>,
      <>Add credit under <ExtLink href="https://console.anthropic.com/settings/billing">Billing</ExtLink> — Anthropic bills per token, so there are no credits to convert.</>,
      <>Open <ExtLink href="https://console.anthropic.com/settings/keys">API Keys</ExtLink> → <b>Create Key</b> → copy it right away (it&apos;s shown only once).</>,
      <>Paste it below, hit <b>Save</b>, then switch <b>Use my Anthropic key</b> on. Images, video and voiceover still run on KIE and ElevenLabs.</>,
    ],
    fields: ["anthropic_api_key"],
    afterFields: "anthropic-direct-toggle",
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
          <span className="block text-xs font-semibold" style={{ color: "var(--brand-text)" }}>50k chrs/month for Starters</span>
          <span className="block text-xs font-semibold mt-1" style={{ color: "var(--brand-text)" }}>100k chrs/month for Pros</span>
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
          <Brain size={18} style={{ color: "var(--brand-text)" }} />
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

  const overBy = text.trim().length - PREFIX_MAX_CHARS;

  async function handleSave() {
    // The route rejects this too. Stopping here keeps the reason next to the
    // box being edited rather than in a toast over a different part of the page.
    const tooLong = prefixTooLongMessage(text);
    if (tooLong) {
      toast.error(tooLong);
      return;
    }
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
          <Pilcrow size={18} style={{ color: "var(--brand-text)" }} />
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
            <div className="flex items-baseline justify-between gap-3">
              <label className="text-xs font-medium" style={{ color: "var(--c-50)" }}>
                Consistency text
              </label>
              {/* Counts down rather than up, so the limit is visible before it
                  is hit instead of only in the error afterwards. */}
              <span className="text-[11px] font-mono tabular-nums"
                style={{ color: overBy > 0 ? "oklch(0.6 0.19 25)" : "var(--c-40)" }}>
                {text.trim().length} / {PREFIX_MAX_CHARS}
              </span>
            </div>
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
            {overBy > 0 ? (
              <p className="text-[11px] leading-relaxed" style={{ color: "oklch(0.6 0.19 25)" }}>
                {overBy.toLocaleString()} characters too long. This is a style
                note added to the front of every image prompt, not a script.
                Describe only what should never change, such as the look, the
                palette and a recurring character, and leave each scene to Heclus.
              </p>
            ) : fromProject && (
              <p className="text-[11px] leading-relaxed" style={{ color: "var(--brand-text)" }}>
                Filled in from the last prefix you set on a project. Save it to
                make it your default for every new project.
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={handleSave}
            title={overBy > 0 ? `Trim ${overBy.toLocaleString()} characters to save` : undefined}
            disabled={saving || overBy > 0}
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
  // Whether the client's own Anthropic key is stored, and whether it's the one
  // Claude calls actually use. Two flags, so turning it off doesn't discard
  // the key.
  const [anthropicKeySaved, setAnthropicKeySaved] = useState(false);
  const [anthropicDirect, setAnthropicDirect] = useState(false);
  const [savingDirect, setSavingDirect] = useState(false);
  const [removing, setRemoving] = useState<keyof FormState | null>(null);
  const [revealed, setRevealed] = useState<Partial<Record<keyof FormState, string>>>({});
  const [revealing, setRevealing] = useState<keyof FormState | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<{ field: keyof FormState; label: string } | null>(null);
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
    if (t === "oneclick" && ONE_CLICK_HIDDEN) return; // ?tab=oneclick deep link
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
        setAnthropicDirect(!!data.anthropic_direct_enabled);
        setAnthropicKeySaved(!!data.has_anthropic_api_key);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  // Direct-billing switch. Writes immediately rather than waiting for Save —
  // it isn't a key being typed, it's a choice about who gets billed, and a
  // toggle that silently needs a separate Save invites the user to think it
  // took effect when it didn't.
  async function setAnthropicDirect2(next: boolean) {
    setSavingDirect(true);
    const prev = anthropicDirect;
    setAnthropicDirect(next);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anthropic_direct_enabled: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to save");
      toast.success(next ? "Claude calls now use your Anthropic key" : "Claude calls are back on your KIE key");
    } catch (err) {
      setAnthropicDirect(prev);
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingDirect(false);
    }
  }

  async function removeAnthropicKey() {
    setSavingDirect(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remove_anthropic_api_key: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to remove");
      setAnthropicDirect(false);
      setAnthropicKeySaved(false);
      const fresh = await fetch("/api/settings").then((r) => r.json());
      setMasked(fresh as FormState);
      toast.success("Anthropic key removed — Claude calls run on your KIE key");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove");
    } finally {
      setSavingDirect(false);
    }
  }

  // Clearing a key is its own action, not an empty Save: the form posts every
  // field, so a blank input means "leave it alone". Without this there was no
  // way out of a key the provider rejects, because a stored value always wins
  // over the platform fallback.
  async function removeKey(field: keyof FormState, label: string) {
    setRemoving(field);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [`remove_${field}`]: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to remove");
      const fresh = await fetch("/api/settings").then((r) => r.json());
      setMasked(fresh as FormState);
      setForm((f) => ({ ...f, [field]: "" }));
      setRevealed((r) => { const next = { ...r }; delete next[field]; return next; });
      setConfirmRemove(null);
      toast.success(`${label} removed.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove");
    } finally {
      setRemoving(null);
    }
  }

  function toggle(key: string) {
    setVisible((v) => ({ ...v, [key]: !v[key] }));
  }

  // Reveal what is actually stored. The masked row only ever showed the last
  // four characters, which is not enough to spot a key that was pasted short
  // or is one of several the user holds. Fetched on demand rather than sent
  // with the page so the full value only leaves the server when asked for.
  async function toggleStoredKey(field: keyof FormState) {
    if (revealed[field]) {
      setRevealed((r) => { const next = { ...r }; delete next[field]; return next; });
      return;
    }
    setRevealing(field);
    try {
      const res = await fetch("/api/settings/reveal", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not read the saved key");
      if (!data.value) { toast.error("No key stored on your account for this service."); return; }
      setRevealed((r) => ({ ...r, [field]: data.value as string }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not read the saved key");
    } finally {
      setRevealing(null);
    }
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
      // A just-saved Anthropic key has to unlock its switch without a reload.
      setAnthropicKeySaved(!!fresh.has_anthropic_api_key);
      setAnthropicDirect(!!fresh.anthropic_direct_enabled);
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
            .filter(([id]) => id !== "oneclick" || !ONE_CLICK_HIDDEN)
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
                ? { background: "oklch(0.72 0.25 285 / 0.15)", color: "var(--accent-purple-text)" }
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
                <Settings size={18} style={{ color: "var(--brand-text)" }} />
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
              {/* gap-6, not gap-4: the card fill is only 8% white on a dark
                  page, so adjacent cards read as one continuous block with a
                  hairline through it unless the gutter is clearly wider than
                  the internal padding steps. */}
              <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
                {SERVICES.filter((svc) => svc.tier === tab).map((svc, idx) => (
                  <div key={svc.title} className="p-5 rounded-2xl flex flex-col gap-4"
                    style={{ background: "oklch(1 0 0 / 0.08)", border: "1px solid oklch(1 0 0 / 0.14)" }}>
                    {/* Card header */}
                    <div className="flex items-start gap-3">
                      <div className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 text-xs font-bold"
                        style={{ background: "oklch(0.72 0.25 285 / 0.15)", color: "var(--brand-text)", border: "1px solid oklch(0.72 0.25 285 / 0.3)" }}>
                        {idx + 1}
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-foreground">{svc.title}</p>
                        <p className="text-xs" style={{ color: "var(--c-40)" }}>{svc.sub}</p>
                        {svc.quota && (
                          <p className="text-xs font-semibold mt-0.5"
                            style={{ color: "var(--brand-text)", ...(svc.perk ? { marginBottom: "40px" } : {}) }}>
                            {svc.quota}
                          </p>
                        )}
                      </div>
                      {svc.href && (
                        <a href={svc.href} target="_blank" rel="noopener noreferrer"
                          className="ml-auto text-xs shrink-0 hover:opacity-80"
                          style={{ color: "var(--brand-text)", textDecoration: "underline" }}>
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
                            <div className="text-xs font-mono px-3 py-2 rounded-lg flex items-center gap-2"
                              style={{ background: "var(--bg-code)", color: "var(--c-40)", border: "1px solid var(--bd-5)" }}>
                              {/* The "Current:" prefix only earns its place
                                  next to a masked stub. Beside the real key it
                                  is noise in front of the thing being read. */}
                              <span className="min-w-0 flex-1 break-all">
                                {revealed[field.key] ?? `Current: ${currentMasked}`}
                              </span>
                              <button type="button" tabIndex={-1}
                                onClick={() => toggleStoredKey(field.key)}
                                disabled={revealing === field.key}
                                title={revealed[field.key] ? "Hide the saved key" : "Show the saved key"}
                                className="shrink-0 transition-opacity hover:opacity-70 disabled:opacity-40"
                                style={{ color: "var(--c-40)" }}>
                                {revealed[field.key] ? <EyeOff size={14} /> : <Eye size={14} />}
                              </button>
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

                          {/* Say it while they are still looking at the field.
                              The save path checks with ElevenLabs anyway, but
                              the key ID is long and plausible-looking, and a
                              round trip to find out is a worse way to learn. */}
                          {field.key === "elevenlabs_api_key"
                            && form[field.key].trim().length > 0
                            && !form[field.key].trim().startsWith("sk_") && (
                            <p className="text-[11px] leading-relaxed" style={{ color: "var(--accent-amber-text)" }}>
                              ElevenLabs keys begin with sk_. The 64-character value listed beside a key is its ID, not the key, and it will not work.
                            </p>
                          )}

                          {/* Anthropic's remove button lives with its billing
                              toggle below, since removing it has to switch
                              that off too. */}
                          {isSet && field.key !== "anthropic_api_key" && (
                            <button
                              type="button"
                              onClick={() => setConfirmRemove({ field: field.key, label: field.label })}
                              disabled={removing !== null}
                              className="text-xs font-medium transition-opacity hover:opacity-70 disabled:opacity-40"
                              style={{ color: "oklch(0.7 0.22 25)" }}
                            >
                              Remove key
                            </button>
                          )}
                        </div>
                      );
                    })}
                    {svc.afterFields === "anthropic-direct-toggle" && (
                      <div className="space-y-2 pt-3" style={{ borderTop: "1px solid oklch(1 0 0 / 0.07)" }}>
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-foreground">Use my Anthropic key</p>
                            <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
                              {anthropicKeySaved
                                ? anthropicDirect
                                  ? "On — scripts, analysis and prompts bill to your Anthropic account."
                                  : "Off — those steps run on your KIE key."
                                : "Save a key above first."}
                            </p>
                          </div>
                          <button
                            type="button"
                            role="switch"
                            aria-checked={anthropicDirect}
                            aria-label="Use my Anthropic key"
                            disabled={!anthropicKeySaved || savingDirect}
                            onClick={() => setAnthropicDirect2(!anthropicDirect)}
                            className="relative shrink-0 w-11 h-6 rounded-full transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                            style={{
                              background: anthropicDirect ? "oklch(0.72 0.25 285)" : "var(--bg-progress)",
                              border: "1px solid var(--bd-10)",
                            }}
                          >
                            <span className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full transition-all"
                              style={{ left: anthropicDirect ? "1.5rem" : "0.25rem", background: "white" }} />
                          </button>
                        </div>
                        {anthropicKeySaved && (
                          <button
                            type="button"
                            onClick={removeAnthropicKey}
                            disabled={savingDirect}
                            className="text-xs font-medium transition-opacity hover:opacity-70 disabled:opacity-40"
                            style={{ color: "oklch(0.7 0.22 25)" }}
                          >
                            Remove key
                          </button>
                        )}
                      </div>
                    )}
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

      {/* Removing a key is one click on a page people open to fix things, and
          the value cannot be recovered afterwards: providers show a key once.
          Worth a confirm. Stays open while the request runs. */}
      <Dialog open={!!confirmRemove} onOpenChange={(open) => { if (!open && !removing) setConfirmRemove(null); }}>
        <DialogContent className="sm:max-w-md" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Remove {confirmRemove?.label}?</DialogTitle>
            <DialogDescription>
              Heclus stops using it right away, and the steps that need it will fail until you save a new key. The value is not recoverable from here afterwards, so copy it first if you still need it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              onClick={() => setConfirmRemove(null)}
              disabled={!!removing}
              className="flex-1 py-2 rounded-xl text-sm font-medium transition-all hover:opacity-80 disabled:opacity-40"
              style={{ background: "oklch(1 0 0 / 0.06)", color: "var(--c-60)", border: "1px solid var(--bd-8)" }}
            >
              Cancel
            </button>
            <button
              onClick={() => { if (confirmRemove) removeKey(confirmRemove.field, confirmRemove.label); }}
              disabled={!!removing}
              className="flex-1 py-2 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50"
              style={{ background: "oklch(0.5 0.22 25)", color: "white" }}
            >
              {removing ? (
                <span className="flex items-center justify-center gap-2">
                  <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                  Removing…
                </span>
              ) : "Remove key"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
