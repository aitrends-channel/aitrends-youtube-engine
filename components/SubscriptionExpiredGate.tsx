"use client";

import { useEffect, useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import { SubscriptionModal } from "@/components/SubscriptionModal";

// Global catch for the subscription-expired 403s the spend-gated API
// routes return (lib/subscription.ts). Rather than threading a handler
// through every call site (project creation, every generation step,
// assemble…), we wrap window.fetch once: any 403 whose body carries
// `subscriptionExpired: true` opens the renewal SubscriptionModal on
// top of whatever page the user is on. The response itself still flows
// back to the caller unchanged, so existing per-page error handling
// (toasts, status resets) keeps working — the modal is additive.
const EVENT = "heclus:subscription-expired";

export function SubscriptionExpiredGate() {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");

  useEffect(() => {
    const orig = window.fetch;
    const patched: typeof window.fetch = async (...args) => {
      const res = await orig(...args);
      if (res.status === 403) {
        // Clone so the real consumer can still read the body.
        res.clone().json().then((d: { subscriptionExpired?: boolean }) => {
          if (d?.subscriptionExpired) window.dispatchEvent(new Event(EVENT));
        }).catch(() => { /* non-JSON 403 — not ours */ });
      }
      return res;
    };
    window.fetch = patched;
    return () => { window.fetch = orig; };
  }, []);

  useEffect(() => {
    const onExpired = () => {
      setOpen((already) => {
        if (!already) {
          createSupabaseBrowserClient().auth.getSession().then(({ data }) => {
            setEmail(data.session?.user?.email ?? "");
          });
        }
        return true;
      });
    };
    window.addEventListener(EVENT, onExpired);
    return () => window.removeEventListener(EVENT, onExpired);
  }, []);

  if (!open) return null;
  return (
    <SubscriptionModal
      email={email}
      hideTryDemo
      onClose={() => setOpen(false)}
      onSuccess={() => {
        setOpen(false);
        // Payment verify already refreshed the auth metadata server-side;
        // reload so every gate re-reads the renewed subscription.
        window.location.reload();
      }}
    />
  );
}
