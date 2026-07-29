"use client";

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { Gem } from "lucide-react";
import { QUOTA_FIELDS, type QuotaConfig, type QuotaKind } from "@/lib/quota-config";
import { QuotaRow } from "./QuotaRow";
import {
  isQuotaDirty, isQuotaValid, toDraft, toPayload,
  type PlanRef, type QuotaDraft,
} from "./draft";

// Config → Quotas. What an admin sets here is what generateAi33TTS
// enforces and what /api/free-usage shows in the user's usage bars.

type QuotasResponse = {
  config: QuotaConfig;
  plans: PlanRef[];
};

const fetcher = (url: string) => fetch(url).then((r) => r.json());

export function QuotasPanel() {
  const { data, mutate, isLoading } = useSWR<QuotasResponse>(
    "/api/admin/quotas",
    fetcher,
    { revalidateOnFocus: false },
  );

  const [draft, setDraft] = useState<QuotaDraft | null>(null);
  const [savingKey, setSavingKey] = useState<QuotaKind | null>(null);
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (!data?.config || hydratedRef.current) return;
    // The fetcher doesn't throw on non-OK, so `data` can be an error
    // envelope (e.g. migration 104 not applied). Only hydrate when every
    // quota is present, so inputs never show "undefined".
    const allPresent = QUOTA_FIELDS.every((f) => !!data.config?.[f.key]?.byPlan);
    if (!allPresent) return;
    hydratedRef.current = true;
    setDraft(toDraft(data.config, data.plans ?? []));
  }, [data]);

  const plans = data?.plans ?? [];

  function setOverride(key: QuotaKind, slug: string, value: string) {
    setDraft((d) => (d ? { ...d, [key]: { ...d[key], [slug]: value } } : d));
  }

  async function saveField(key: QuotaKind) {
    if (!draft) return;
    if (!isQuotaValid(draft, key, plans)) {
      toast.error("Fix the highlighted value before saving");
      return;
    }
    setSavingKey(key);
    try {
      // Partial PUT so a concurrent edit to another quota isn't clobbered.
      const res = await fetch("/api/admin/quotas", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: toPayload(draft, key, plans) }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error ?? "Failed to save");
      toast.success("Quota saved");
      await mutate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3">
        <Gem size={18} className="shrink-0 mt-0.5" style={{ color: "oklch(0.62 0.15 220)" }} />
        <div>
          <h3 className="text-base font-bold leading-tight" style={{ color: "var(--c-90)" }}>
            Free &amp; perk quotas per plan
          </h3>
          <p className="text-xs mt-1.5 leading-relaxed" style={{ color: "var(--c-50)" }}>
            How much free usage each plan gets. Blank or
            <span className="font-semibold"> 0</span> = that plan doesn&apos;t get it. Admins count as Pro.
          </p>
        </div>
      </div>

      {!isLoading && data && !data.config && (
        <div className="p-3.5 rounded-xl text-xs leading-relaxed"
          style={{ background: "oklch(0.62 0.18 25 / 0.08)", border: "1px solid oklch(0.62 0.18 25 / 0.25)", color: "var(--c-90)" }}>
          Couldn&apos;t load quotas. On a fresh environment, apply migration 104
          (product_config.free_quotas) first.
        </div>
      )}

      <div className="space-y-4">
        {QUOTA_FIELDS.map((f) => (
          <QuotaRow
            key={f.key}
            field={f}
            saved={data?.config?.[f.key]}
            draftByPlan={draft?.[f.key] ?? {}}
            plans={plans}
            dirty={!!draft && !!data?.config && isQuotaDirty(draft, data.config, f.key, plans)}
            valid={!!draft && isQuotaValid(draft, f.key, plans)}
            saving={savingKey === f.key}
            savingOther={savingKey !== null && savingKey !== f.key}
            disabled={isLoading || savingKey === f.key || !draft}
            onOverrideChange={(slug, v) => setOverride(f.key, slug, v)}
            onSave={() => saveField(f.key)}
          />
        ))}
      </div>
    </div>
  );
}
