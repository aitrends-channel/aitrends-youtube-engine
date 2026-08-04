"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import { HelpCircle, Send, X, CheckCircle2, ChevronDown, LifeBuoy, Star } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { FeedbackDialog } from "@/components/FeedbackDialog";

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
        Open <Link href="/setup" className="font-semibold text-zinc-900 underline underline-offset-2 hover:opacity-80">Config</Link> and paste your KIE and ElevenLabs keys. KIE powers script/image/video generation; ElevenLabs powers voiceovers and caption alignment.
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
    a: <>Make plan changes at user profile → Plan, or <a href="/plan" className="underline font-medium" style={{ color: "oklch(0.55 0.22 285)" }}>click here</a> directly.</>,
  },
];

export function HelpButton() {
  const [open, setOpen] = useState(false);
  // Chooser menu (Support / Feedback) shown above the bubble. The
  // bubble no longer opens the support dialog directly.
  const [menuOpen, setMenuOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // Feedback requires auth (rows are keyed to user_id) — hide the
  // option for anonymous visitors. getSession reads local storage, so
  // this costs nothing on page load.
  const [signedIn, setSignedIn] = useState(false);
  useEffect(() => {
    let cancelled = false;
    createSupabaseBrowserClient().auth.getSession().then(({ data }) => {
      if (!cancelled && data.session) setSignedIn(true);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const [authEmail, setAuthEmail] = useState<string | null>(null);
  const [emailInput, setEmailInput] = useState("");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Index of the FAQ row currently expanded. -1 = all collapsed.
  // Accordion-style: only one open at a time keeps the modal calm.
  const [openFaqIdx, setOpenFaqIdx] = useState<number>(-1);

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
        onClick={() => setMenuOpen((v) => !v)}
        aria-label="Open help menu"
        title="Help"
        className="fixed bottom-5 right-5 z-[350] w-12 h-12 rounded-full flex items-center justify-center shadow-lg transition-all hover:scale-105 active:scale-95 cursor-pointer"
        style={{ background: "oklch(0.72 0.25 285)", color: "white", boxShadow: "0 6px 18px oklch(0.72 0.25 285 / 0.45)" }}
      >
        {menuOpen ? <X size={20} /> : <HelpCircle size={22} />}
      </button>

      {/* Support / Feedback chooser — small white card above the bubble. */}
      {menuOpen && (
        <>
          <div className="fixed inset-0 z-[350]" onClick={() => setMenuOpen(false)} />
          <div
            className="fixed bottom-[4.75rem] right-5 z-[360] w-48 rounded-xl bg-white shadow-2xl p-1.5 space-y-0.5"
            style={{ border: "1px solid oklch(0 0 0 / 0.08)" }}
          >
            <button
              type="button"
              onClick={() => { setMenuOpen(false); setOpen(true); }}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-semibold text-zinc-900 hover:bg-zinc-100 transition-colors cursor-pointer text-left"
            >
              <LifeBuoy size={16} style={{ color: "oklch(0.72 0.25 285)" }} />
              Support
            </button>
            {signedIn && (
              <button
                type="button"
                onClick={() => { setMenuOpen(false); setFeedbackOpen(true); }}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm font-semibold text-zinc-900 hover:bg-zinc-100 transition-colors cursor-pointer text-left"
              >
                <Star size={16} style={{ color: "oklch(0.75 0.15 85)" }} />
                Feedback
              </button>
            )}
          </div>
        </>
      )}

      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />

      <Dialog open={open} onOpenChange={(v) => (v ? setOpen(true) : closeAndReset())}>
        <DialogContent
          showCloseButton={false}
          className={
            // Mobile: keep the centered sheet — easier to thumb-reach and
            // the floating button is also nearer the center thumb zone.
            // Desktop (sm+): anchor bottom-right and stretch the modal
            // all the way to the bottom edge of the viewport. sm:bottom-5
            // matches the help bubble's bottom alignment so the modal
            // sits flush with the same baseline. Width stays at max-w-xl
            // (576px) so the FAQ list + contact form breathe without
            // crowding.
            //
            // flex column + overflow-hidden keeps the inner scroll area
            // (FAQ + form combined) constrained inside the modal so the
            // contact form can't visibly bleed past the bottom edge on
            // shorter viewports.
            "z-[350] max-w-lg sm:max-w-xl " +
            // Mobile: pin 10px from the top (instead of vertically centered)
            // so the popup clears the screen top edge / status bar.
            "top-[10px] translate-y-0 " +
            "sm:top-5 sm:left-auto sm:bottom-5 sm:right-5 " +
            "sm:translate-x-0 sm:translate-y-0 " +
            "max-h-[calc(100vh-1.25rem)] sm:max-h-[calc(100vh-2.5rem)] " +
            "flex flex-col overflow-hidden"
          }
        >
          <DialogHeader
            className="shrink-0 -mx-4 -mt-4 px-4 pt-4 pb-3 rounded-t-xl"
            style={{ background: "oklch(0.72 0.25 285)" }}
          >
            <div className="flex items-center justify-between gap-3">
              <DialogTitle className="!text-white inline-flex items-center gap-2">
                <Image
                  src="/heclus-icon-white-transparent.svg"
                  alt="Heclus"
                  width={40}
                  height={40}
                  className="shrink-0"
                />
                Help &amp; Support
              </DialogTitle>
              <button
                type="button"
                onClick={closeAndReset}
                aria-label="Close help"
                className="w-7 h-7 rounded-md inline-flex items-center justify-center transition-colors cursor-pointer hover:bg-white/15"
              >
                <X size={16} className="text-white" />
              </button>
            </div>
            <DialogDescription className="!text-white/90">
              Get help with common issues or submit a support ticket.
            </DialogDescription>
          </DialogHeader>

          {/* One scrollable region for FAQs + contact form combined.
              min-h-0 + flex-1 lets it shrink inside the flex parent so
              the form section can never overflow past the modal bottom. */}
          <div className="flex-1 min-h-0 overflow-y-auto pr-1 -mr-1">
            <div className="space-y-2 mt-2">
              {FAQS.map((faq, idx) => {
                const isOpen = openFaqIdx === idx;
                return (
                  <div
                    key={faq.q}
                    className="rounded-lg overflow-hidden transition-all"
                    style={{ border: "1px solid oklch(0 0 0 / 0.08)" }}
                  >
                    <button
                      type="button"
                      onClick={() => setOpenFaqIdx(isOpen ? -1 : idx)}
                      className="w-full flex items-center justify-between gap-3 px-3 py-2.5 text-left cursor-pointer hover:bg-zinc-50 transition-colors"
                    >
                      <span className="text-sm font-semibold text-zinc-900">{faq.q}</span>
                      <ChevronDown
                        size={16}
                        className="shrink-0 text-zinc-500 transition-transform"
                        style={{ transform: isOpen ? "rotate(180deg)" : "rotate(0deg)" }}
                      />
                    </button>
                    {isOpen && (
                      <div className="px-3 pb-3 -mt-0.5">
                        <p className="text-sm text-zinc-600 leading-relaxed">{faq.a}</p>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Community CTA — Discord. Sits above the ticket form so
                users see the peer channel before filing a ticket; kept
                calm (single line, brand-tinted) so it doesn't drown
                out the primary Contact action. Renders in both the
                form and the post-submit "sent" states. */}
            <a
              href="https://discord.gg/N53RuARnwn"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-4 flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 transition-colors hover:bg-[color:oklch(0.55_0.22_270/0.06)]"
              style={{ border: "1px solid oklch(0.55 0.22 270 / 0.25)", background: "oklch(0.55 0.22 270 / 0.04)" }}
            >
              <span className="flex items-center gap-2.5">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                  className="shrink-0"
                >
                  <path
                    d="M19.27 5.33A17.5 17.5 0 0 0 14.9 4l-.22.4a15.9 15.9 0 0 0-5.36 0L9.1 4a17.5 17.5 0 0 0-4.37 1.33C1.94 9.5 1.2 13.55 1.57 17.55a17.7 17.7 0 0 0 5.4 2.73l.44-.6a12.7 12.7 0 0 1-2-1c.17-.13.34-.26.5-.4a12.6 12.6 0 0 0 12.18 0l.5.4c-.62.38-1.3.72-2 1l.44.6a17.7 17.7 0 0 0 5.4-2.73c.46-4.63-.75-8.65-3.16-12.22ZM8.52 15.33c-1.06 0-1.94-1-1.94-2.22 0-1.23.85-2.22 1.94-2.22 1.09 0 1.96 1 1.94 2.22 0 1.23-.85 2.22-1.94 2.22Zm6.96 0c-1.06 0-1.93-1-1.93-2.22 0-1.23.85-2.22 1.93-2.22 1.09 0 1.96 1 1.94 2.22 0 1.23-.85 2.22-1.94 2.22Z"
                    fill="oklch(0.55 0.22 270)"
                  />
                </svg>
                <span className="flex flex-col leading-tight">
                  <span className="text-sm font-semibold text-zinc-900">Join our Discord community</span>
                  <span className="text-xs text-zinc-500">Ask other creators, share workflows, get faster answers.</span>
                </span>
              </span>
              <span className="text-xs font-semibold shrink-0" style={{ color: "oklch(0.55 0.22 270)" }}>Open →</span>
            </a>

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
                <div className="flex items-center gap-3">
                  <Image
                    src="/avartar.png"
                    alt="Heclus Support"
                    width={44}
                    height={44}
                    className="rounded-full shrink-0"
                  />
                  <div>
                    <p className="text-sm font-semibold text-zinc-900">Contact us</p>
                    <p className="text-xs text-zinc-500">Someone will review your ticket and respond within 24 hours.</p>
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-bold text-zinc-900">Your email</label>
                  {authEmail ? (
                    <>
                      <p className="text-sm font-bold text-zinc-900 break-all">{emailInput}</p>
                      <p className="text-[11px] text-zinc-500">Sent from your signed-in account.</p>
                    </>
                  ) : (
                    <input
                      type="email"
                      value={emailInput}
                      onChange={(e) => setEmailInput(e.target.value)}
                      disabled={sending}
                      required
                      placeholder="you@example.com"
                      className="w-full px-3 py-2.5 rounded-lg text-sm outline-none bg-white text-zinc-900 transition-all"
                      style={{
                        border: "2px solid oklch(0.72 0.25 285 / 0.45)",
                        boxShadow: "0 1px 3px oklch(0 0 0 / 0.08)",
                      }}
                    />
                  )}
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-bold text-zinc-900">Subject</label>
                  <input
                    type="text"
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    disabled={sending}
                    required
                    maxLength={200}
                    placeholder="Short summary of the issue"
                    className="w-full px-3 py-2.5 rounded-lg text-sm outline-none bg-white text-zinc-900 transition-all"
                    style={{
                      border: "2px solid oklch(0.72 0.25 285 / 0.45)",
                      boxShadow: "0 1px 3px oklch(0 0 0 / 0.08)",
                    }}
                  />
                </div>
                <div className="space-y-1.5">
                  <label className="text-sm font-bold text-zinc-900">Message</label>
                  <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    disabled={sending}
                    required
                    rows={4}
                    placeholder="What's going on? Include any error message, project ID, or steps to reproduce."
                    className="w-full px-3 py-2.5 rounded-lg text-sm outline-none bg-white text-zinc-900 resize-y transition-all"
                    style={{
                      border: "2px solid oklch(0.72 0.25 285 / 0.45)",
                      boxShadow: "0 1px 3px oklch(0 0 0 / 0.08)",
                    }}
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
