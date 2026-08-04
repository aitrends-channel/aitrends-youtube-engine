import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { resolveQuotaCap, QUOTA_UNLIMITED } from "@/lib/quota-config";
import { planSlugOf } from "@/lib/plans-gating";
import { isAdminUser } from "@/lib/admin";
import type { User } from "@supabase/supabase-js";

export const GB = 1024 ** 3;

export function storageFullMessage(capBytes: number): string {
  return `You've used all ${(capBytes / GB).toFixed(0)} GB of your storage. ` +
    `Delete a project's assets or upgrade your plan to keep generating.`;
}

export interface StorageStatus {
  usedBytes: number;
  /** Plan allowance plus any admin grant. null = unlimited. */
  capBytes: number | null;
  full: boolean;
  /** Null when the sweep has never run for this account. */
  measuredAt: string | null;
}

/** Mirrors userFolderFor in supabase/storage. */
export function storagePrefixFor(user: { email?: string | null; id: string }): string {
  return ((user.email ?? user.id) || user.id).trim().toLowerCase();
}

/** Per-plan allowance (stored in GB) plus the per-account grant; null = no ceiling. */
export async function storageCapBytes(user: User, bonusBytes = 0): Promise<number | null> {
  const gbCap = await resolveQuotaCap("storage_bytes", planSlugOf(user), isAdminUser(user));
  if (gbCap === QUOTA_UNLIMITED) return null;
  return gbCap * GB + bonusBytes;
}

/** Cached sweep result — hours stale by design, see migration 112. */
export async function storageStatus(user: User): Promise<StorageStatus> {
  const { data } = await supabase
    .from("storage_usage")
    .select("bytes, bonus_bytes, measured_at")
    .eq("prefix", storagePrefixFor(user))
    .maybeSingle();

  const usedBytes = Number(data?.bytes ?? 0);
  const capBytes = await storageCapBytes(user, Number(data?.bonus_bytes ?? 0));
  return {
    usedBytes,
    capBytes,
    full: capBytes !== null && usedBytes >= capBytes,
    measuredAt: (data?.measured_at as string | undefined) ?? null,
  };
}

/** Null when the read itself failed — callers fail open, since a cost control
 *  must not stop a generation on a DB blip. */
async function statusOrNull(user: User): Promise<StorageStatus | null> {
  try {
    return await storageStatus(user);
  } catch (e) {
    console.warn("[storage-quota] check failed, allowing write:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Route guard shaped like requireActiveSubscription — the response to send,
 *  or null when there's headroom. 403 rather than 507: the app's fetch
 *  interceptor already inspects 403 bodies for this kind of gate. */
export async function requireStorageHeadroom(user: User): Promise<NextResponse | null> {
  const status = await statusOrNull(user);
  if (!status?.full || status.capBytes === null) return null;
  return NextResponse.json(
    {
      error: storageFullMessage(status.capBytes),
      storageFull: true,
      usedBytes: status.usedBytes,
      capBytes: status.capBytes,
    },
    { status: 403 },
  );
}

/** Same check for background callers holding a user id, not a session (the
 *  1Click tick). Null means carry on. */
export async function storageFullNote(userId: string): Promise<string | null> {
  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error || !data.user) return null;
    const status = await storageStatus(data.user);
    if (!status.full || status.capBytes === null) return null;
    return storageFullMessage(status.capBytes);
  } catch (e) {
    console.warn("[storage-quota] background check failed:", e instanceof Error ? e.message : e);
    return null;
  }
}
