"use client";

import { useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Spinner } from "@/components/ui/spinner";
import type { SupportAgentConfig } from "@/lib/support-agent/agent";

// The support agent's switches. Deliberately plain: the only thing that matters
// here is being able to see at a glance whether a machine is emailing customers,
// and turn it off in one click if it is.

const fetcher = (url: string) => fetch(url).then((r) => r.json());

function Row({ label, help, children }: { label: string; help: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-3" style={{ borderTop: "1px solid oklch(0 0 0 / 0.09)" }}>
      <div className="min-w-0">
        <p className="text-sm font-semibold" style={{ color: "var(--c-85)" }}>{label}</p>
        <p className="text-xs mt-0.5 leading-relaxed" style={{ color: "var(--c-45)" }}>{help}</p>
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={on} disabled={disabled}
      onClick={() => onChange(!on)}
      className="relative w-11 h-6 rounded-full transition-all disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
      style={{ background: on ? "oklch(0.52 0.20 145)" : "oklch(0 0 0 / 0.12)", border: "1px solid oklch(0 0 0 / 0.1)" }}>
      <span className="absolute top-1/2 -translate-y-1/2 w-4 h-4 rounded-full transition-all"
        style={{ left: on ? "1.5rem" : "0.25rem", background: "white" }} />
    </button>
  );
}

export function SupportAgentPanel() {
  const { data, mutate, isLoading } = useSWR<{ config: SupportAgentConfig }>("/api/admin/support-agent", fetcher);
  const [saving, setSaving] = useState(false);
  const config = data?.config;

  async function patch(change: Partial<SupportAgentConfig>) {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/support-agent", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(change),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Save failed");
      await mutate({ config: body.config }, { revalidate: false });
      toast.success("Saved.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (isLoading || !config) {
    return <div className="rounded-2xl p-5 flex items-center gap-2 text-sm" style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.10)", color: "var(--c-45)" }}><Spinner size={14} /> Loading…</div>;
  }

  const live = config.auto_reply_enabled && !config.auto_reply_dry_run;

  return (
    <div className="rounded-2xl p-5" style={{ background: "var(--bg-card)", border: "1px solid oklch(0 0 0 / 0.10)" }}>
      <div className="flex items-start justify-between gap-3 mb-1">
        <div>
          <p className="text-sm font-semibold" style={{ color: "var(--c-85)" }}>Heclus AI Agent</p>
          <p className="text-xs mt-0.5" style={{ color: "var(--c-45)" }}>
            Answers in-app chat, and unattended tickets and email when switched on.
          </p>
        </div>
        {live && (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider shrink-0"
            style={{ background: "oklch(0.6 0.19 25 / 0.1)", color: "oklch(0.45 0.15 25)", border: "1px solid oklch(0.6 0.19 25 / 0.3)" }}>
            Emailing customers
          </span>
        )}
      </div>

      <div className="mt-3">
        <Row label="In-app chat" help="Signed-in users can chat from the help bubble. It offers a ticket when it cannot resolve something.">
          <Toggle on={config.chat_enabled} disabled={saving} onChange={(v) => patch({ chat_enabled: v })} />
        </Row>

        <Row label="Answer unattended tickets"
          help={`Answers tickets nobody replied to within ${config.auto_reply_delay_minutes} minutes. Never billing, refunds or data loss.`}>
          <Toggle on={config.auto_reply_enabled} disabled={saving} onChange={(v) => patch({ auto_reply_enabled: v })} />
        </Row>

        <Row label="Answer unattended email"
          help="Extends the same sweep to the shared inbox. Only mail from a known account, and never a thread a person has already answered.">
          <Toggle on={config.auto_reply_emails_enabled} disabled={saving || !config.auto_reply_enabled}
            onChange={(v) => patch({ auto_reply_emails_enabled: v })} />
        </Row>

        {/* The important one. Left on, the worker still writes a draft on every
            eligible ticket but sends nothing, so a week of drafts can be read
            before any of it reaches a customer. */}
        <Row label="Dry run"
          help="Records drafts, sends nothing. Turn off only once the drafts read right.">
          <Toggle on={config.auto_reply_dry_run} disabled={saving || !config.auto_reply_enabled}
            onChange={(v) => patch({ auto_reply_dry_run: v })} />
        </Row>

        <Row label="Grace period" help="How long an admin gets before the agent steps in.">
          <div className="flex items-center gap-2">
            <input
              type="number" min={1} max={1440}
              defaultValue={config.auto_reply_delay_minutes}
              disabled={saving}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (v && v !== config.auto_reply_delay_minutes) void patch({ auto_reply_delay_minutes: v });
              }}
              className="w-20 px-2 py-1 rounded-lg text-sm text-right bg-white text-zinc-900 ring-1 ring-zinc-200 focus:ring-zinc-400 outline-none"
            />
            <span className="text-xs" style={{ color: "var(--c-45)" }}>minutes</span>
          </div>
        </Row>
      </div>

      {live && (
        <p className="text-xs mt-3 rounded-lg px-3 py-2 leading-relaxed"
          style={{ background: "oklch(0.6 0.19 25 / 0.07)", border: "1px solid oklch(0.6 0.19 25 / 0.25)", color: "oklch(0.45 0.15 25)" }}>
          Sending email to customers without review. One automated reply per ticket, and its wording is
          kept on the ticket.
        </p>
      )}
    </div>
  );
}
