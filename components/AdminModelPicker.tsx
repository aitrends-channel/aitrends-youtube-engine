"use client";

import { useEffect, useState, useRef } from "react";
import { ChevronDown, Sparkles } from "lucide-react";
import { useIsAdmin } from "@/hooks/useIsAdmin";
import { ANTHROPIC_MODEL_OPTIONS, DEFAULT_ANTHROPIC_MODEL } from "@/lib/claude/models";

interface AdminModelPickerProps {
  // Unique key per step so each page remembers its own choice
  // independently (e.g. "script", "ideas", "prompts").
  storageKey: string;
  // Called whenever the user picks a model. Pass the empty string to
  // reset to default. Also fires once on mount with the persisted value.
  onChange: (modelId: string) => void;
  // Optional override for visual context (e.g. "Script", "Analyse").
  // Defaults to a generic label.
  label?: string;
}

// Compact admin-only "Choose model" dropdown. Renders null for
// non-admin accounts so regular users never see (or can interact with)
// the override. Selection persists in localStorage, keyed per step, so
// admins don't have to re-pick after a refresh.
export function AdminModelPicker({ storageKey, onChange, label = "Model" }: AdminModelPickerProps) {
  const isAdmin = useIsAdmin();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string>("");
  const containerRef = useRef<HTMLDivElement>(null);

  // Load persisted choice + replay it to the parent so the page starts
  // with the right model without an extra click.
  useEffect(() => {
    if (!isAdmin) return;
    try {
      const saved = window.localStorage.getItem(`admin-model:${storageKey}`) ?? "";
      setSelected(saved);
      onChange(saved);
    } catch {
      // localStorage can throw in some sandbox modes — silently no-op.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAdmin, storageKey]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (containerRef.current && t && !containerRef.current.contains(t)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  if (!isAdmin) return null;

  function pick(modelId: string) {
    setSelected(modelId);
    setOpen(false);
    try {
      if (modelId) window.localStorage.setItem(`admin-model:${storageKey}`, modelId);
      else window.localStorage.removeItem(`admin-model:${storageKey}`);
    } catch { /* sandbox no-op */ }
    onChange(modelId);
  }

  const current = ANTHROPIC_MODEL_OPTIONS.find((m) => m.id === selected);
  const displayName = current?.name ?? "Default";

  return (
    <div ref={containerRef} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-md transition-all hover:opacity-90"
        style={{
          background: "oklch(0.72 0.25 285 / 0.08)",
          border: "1px solid oklch(0.72 0.25 285 / 0.25)",
          color: "oklch(0.72 0.25 285)",
        }}
        title="Admin override — pick which model executes this step"
      >
        <Sparkles size={11} />
        <span style={{ opacity: 0.7 }}>{label}:</span>
        <span>{displayName}</span>
        <ChevronDown size={11} />
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-30 min-w-[220px] rounded-lg overflow-hidden py-1 shadow-2xl"
          style={{ background: "var(--bg-card)", border: "1px solid var(--bd-10)" }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => pick("")}
            className="w-full text-left px-3 py-2 text-xs transition-all hover:opacity-90"
            style={{
              background: selected === "" ? "oklch(0.72 0.25 285 / 0.08)" : "transparent",
              color: "oklch(0.3 0 0)",
            }}
          >
            <div className="font-semibold">Default ({DEFAULT_ANTHROPIC_MODEL})</div>
            <div className="text-[10px] mt-0.5" style={{ color: "var(--c-45)" }}>
              Use the hardcoded server default
            </div>
          </button>
          {ANTHROPIC_MODEL_OPTIONS.map((m) => (
            <button
              key={m.id}
              type="button"
              role="menuitem"
              onClick={() => pick(m.id)}
              className="w-full text-left px-3 py-2 text-xs transition-all hover:opacity-90"
              style={{
                background: selected === m.id ? "oklch(0.72 0.25 285 / 0.08)" : "transparent",
                color: "oklch(0.3 0 0)",
              }}
            >
              <div className="font-semibold">{m.name}</div>
              {m.notes && (
                <div className="text-[10px] mt-0.5" style={{ color: "var(--c-45)" }}>
                  {m.notes}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
