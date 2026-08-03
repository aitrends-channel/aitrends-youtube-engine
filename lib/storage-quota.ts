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
  /** True once usage has reached the cap. Always false when unlimited. */
  full: boolean;
  /** Null when the sweep has never run for this account. */
  measuredAt: string | null;
}

/** The R2 key prefix for a user — mirrors userFolderFor in supabase/storage. */
export function storagePrefixFor(user: { email?: string | null; id: string }): string {
  return ((user.email ?? user.id) || user.id).trim().toLowerCase();
}

/** Cap in bytes from the admin per-plan allowance (stored in GB) plus the
 *  per-account grant. Null means no ceiling. */
export async function storageCapBytes(user: User, bonusBytes = 0): Promise<number | null> {
  const gbCap = await resolveQuotaCap("storage_bytes", planSlugOf(user), isAdminUser(user));
  if (gbCap === QUOTA_UNLIMITED) return null;
  return gbCap * GB + bonusBytes;
}

/** Reads the cached sweep result. Usage is hours stale by design — see
 *  migration 112 for why this is not summed live. */
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

/** Reads the status, or null when the read itself failed.
 *
 *  Both callers below fail open on null: a storage cap is a cost control,
 *  not a correctness boundary, and a transient DB blip must not stop
 *  someone mid-generation. */
async function statusOrNull(user: User): Promise<StorageStatus | null> {
  try {
    return await storageStatus(user);
  } catch (e) {
    console.warn("[storage-quota] check failed, allowing write:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Route guard, same shape as requireActiveSubscription: returns the
 *  response to send back, or null when there's headroom. Goes right after
 *  the auth/subscription checks so the user is told once up front rather
 *  than part-way through a batch of images.
 *
 *  403 + a flag rather than 507, because the app's fetch interceptor
 *  already inspects 403 bodies for exactly this kind of gate. */
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

/** Same check for background callers that hold a user id rather than a
 *  session — the 1Click tick loop, which turns the note into a
 *  needs-attention message. Null means "carry on". */
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
