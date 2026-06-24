"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { HelpCircle, Send, X, CheckCircle2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

// Floating help bubble, bottom-right on every page. Opens a small
// white dialog with a fixed-list FAQ and a contact form that files
// a ticket into the support_tickets table. The form auto-fills the
// signed-in user's email and locks the field; anonymous visitors
// type theirs in.
//
// Keep the FAQ list short (5–7 items) — long lists become an inert
// wall of text people scroll past. When something becomes a recurring
// support theme, add it here so future users find it before opening
// a ticket.

interface Faq {
  q: string;
  a: React.ReactNode;
}

const FAQS: Faq[] = [
  {
    q: "Where do I add my API keys?",
    a: (
      <>
        Open <Link href="/setup" className="font-semibold text-zinc-900 underline underline-offset-2 hover:opacity-80">Setup</Link> and paste your KIE and ElevenLabs keys. KIE powers script/image/video generation; ElevenLabs powers voiceovers and caption alignment.
      </>
    ),
  },
  {
    q: "Why does a niche refuse to start?",
    a: <>You need both KIE and ElevenLabs keys saved before creating a niche. Add them on the Setup page, then try again.</>,
  },
  {
    q: "Why is my voiceover slow?",
    a: <>Voiceovers go direct to ElevenLabs and are typically 1–3 seconds per beat. If a single beat takes much longer, your ElevenLabs plan may be rate-limiting concurrent requests. Lower the per-batch parallelism or upgrade your ElevenLabs tier.</>,
  },
  {
    q: "Where can I see my usage and costs?",
    a: <>Open any project and click the Cost tab in the sidebar. Aggregates per step (script, images, video, voiceover) with the model that ran it.</>,
  },
  {
    q: "How do I change or cancel my plan?",
    a: <>Plan changes flow through your Dodo customer portal. Use the contact form below and we'll send you the management link tied to your account.</>,
  },
];

export function HelpButton() {
  const [open, setOpen] = useState(false);
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Look up the signed-in email lazily on first modal open. Saves the
  // unauthenticated case from paying for an auth round-trip on every
  // page load (the button mounts in the root layout) — and keeps the
  // form responsive: open → email pre-filled within a tick.
  useEffect(() => {
    if (!open || authEmail !== null) return;
    let cancelled = false;
    (async () => {
      try {
        const client = createSupabaseBrowserClient();
        const { data: { user } } = await client.auth.getUser();
        if (!cancelled && user?.email) {
          setAuthEmail(user.email);
          setEmailInput((current) => current || user.email!);
        }
      } catch { /* anon — leave the email input empty + editable */ }
    })();
    return () => { cancelled = true; };
  }, [open, authEmail]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSending(true);
    try {
      const res = await fetch("/api/support/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: emailInput.trim(),
          subject: subject.trim(),
          message: message.trim(),
        }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Send failed");
      setSent(true);
      setSubject("");
      setMessage("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Send failed");
    } finally {
      setSending(false);
    }
  }

  function closeAndReset() {
    setOpen(false);
    // Delay the reset so the close animation doesn't visibly flicker
    // back to the form mid-fade. 250ms ≥ the Dialog fade duration.
    setTimeout(() => {
      setSent(false);
      setError(null);
    }, 250);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open help"
        title="Help"
        className="fixed bottom-5 right-5 z-50 w-12 h-12 rounded-full flex items-center justify-center shadow-lg transition-all hover:scale-105 active:scale-95 cursor-pointer"
        style={{ background: "oklch(0.72 0.25 285)", color: "white", boxShadow: "0 6px 18px oklch(0.72 0.25 285 / 0.45)" }}
      >
        <HelpCircle size={22} />
      </button>

      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : closeAndReset())}>
        <DialogContent
          showCloseButton={false}
          className={
            // Mobile: keep the centered sheet — easier to thumb-reach and
            // the floating button is also nearer the center thumb zone.
            // Desktop (sm+): anchor bottom-right, just above the help
            // bubble (which lives at right-5 / bottom-5, 48px tall).
            // bottom-20 = 80px → ~12px gap above the bubble. Width
            // bumped to max-w-xl (576px) so the FAQ list + contact form
            // breathe without crowding.
            //
            // flex column + overflow-hidden keeps the inner scroll area
            // (FAQ + form combined) constrained inside the modal so the
            // contact form can't visibly bleed past the bottom edge on
            // shorter viewports.
            "max-w-lg sm:max-w-xl " +
            "sm:top-auto sm:left-auto sm:bottom-20 sm:right-5 " +
            "sm:translate-x-0 sm:translate-y-0 " +
            "max-h-[calc(100vh-6rem)] " +
            "flex flex-col overflow-hidden"
          }
        >
          <DialogHeader className="shrink-0">
            <div className="flex items-center justify-between gap-3">
              <DialogTitle>Help &amp; Support</DialogTitle>
              <button
                type="button"
                onClick={closeAndReset}
                aria-label="Close help"
                className="w-7 h-7 rounded-md inline-flex items-center justify-center transition-colors hover:bg-zinc-100 cursor-pointer"
              >
                <X size={16} className="text-zinc-600" />
              </button>
            </div>
            <DialogDescription>
              Common questions first. Still stuck? Send a ticket — humans usually reply within a business day.
            </DialogDescription>
          </DialogHeader>

          {/* One scrollable region for FAQs + contact form combined.
              min-h-0 + flex-1 lets it shrink inside the flex parent so
              the form section can never overflow past the modal bottom. */}
          <div className="flex-1 min-h-0 overflow-y-auto pr-1 -mr-1">
            <div className="space-y-4 mt-2">
              {FAQS.map((faq) => (
                <div key={faq.q} className="space-y-1">
                  <p className="text-sm font-semibold text-zinc-900">{faq.q}</p>
                  <p className="text-sm text-zinc-600 leading-relaxed">{faq.a}</p>
                </div>
              ))}
            </div>

            <div className="mt-5 pt-4 border-t border-zinc-200">
            {sent ? (
              <div className="flex flex-col items-center text-center py-3 gap-2">
                <div
                  className="w-10 h-10 rounded-full flex items-center justify-center"
                  style={{ background: "oklch(0.55 0.15 145 / 0.12)", color: "oklch(0.55 0.15 145)" }}
                >
                  <CheckCircle2 size={20} />
                </div>
                <p className="text-sm font-semibold text-zinc-900">Ticket received</p>
                <p className="text-xs text-zinc-600">We&apos;ll reply to <span className="font-mono">{emailInput}</span> within a business day.</p>
                <button
                  type="button"
                  onClick={closeAndReset}
                  className="mt-2 text-xs font-medium text-zinc-700 hover:text-zinc-900 underline underline-offset-2 cursor-pointer"
                >
                  Close
                </button>
              </div>
            ) : (
              <form onSubmit={submit} className="space-y-3">
                <p className="text-sm font-semibold text-zinc-900">Contact us</p>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-zinc-600">Your email</label>
                  <input
                    type="email"
                    value={emailInput}
                    onChange={(e) => setEmailInput(e.target.value)}
                    disabled={sending || !!authEmail}
                    required
                    placeholder="you@example.com"
                    className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400 disabled:bg-zinc-50 disabled:text-zinc-500"
                  />
                  {authEmail && (
                    <p className="text-[11px] text-zinc-500">Sent from your signed-in account.</p>
                  )}
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-zinc-600">Subject</label>
                  <input
                    type="text"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    disabled={sending}
                    required
                    maxLength={200}
                    placeholder="Short summary of the issue"
                    className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-semibold text-zinc-600">Message</label>
                  <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    disabled={sending}
                    required
                    rows={4}
                    placeholder="What's going on? Include any error message, project ID, or steps to reproduce."
                    className="w-full px-3 py-2 rounded-lg text-sm outline-none bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400 resize-y"
                  />
                </div>
                {error && (
                  <p
                    className="text-xs px-3 py-2 rounded-lg"
                    style={{ background: "oklch(0.6 0.22 25 / 0.08)", color: "oklch(0.55 0.22 25)", border: "1px solid oklch(0.6 0.22 25 / 0.2)" }}
                  >
                    {error}
                  </p>
                )}
                <button
                  type="submit"
                  disabled={sending || !emailInput.trim() || !subject.trim() || !message.trim()}
                  className="w-full inline-flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl text-sm font-semibold transition-all hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                  style={{ background: "oklch(0.72 0.25 285)", color: "white" }}
                >
                  {sending ? (
                    <>
                      <Spinner size={14} className="text-white" />
                      Sending…
                    </>
                  ) : (
                    <>
                      <Send size={14} />
                      Send ticket
                    </>
                  )}
                </button>
              </form>
            )}
          </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
