import { supabase } from "@/lib/supabase/client";
import { getPublicUrl } from "@/lib/supabase/storage";

// Sound effects and elements the customer uploaded, alongside the ones Heclus
// ships.
//
// A built-in is referred to by its filename ("swish", "subscribe"), because
// that is what it is: a file in the worker's assets folder. A custom one cannot
// be, so it is referred to as "custom:<uuid>" and resolved through user_assets.
// Both shapes live in the same column, and the database rejects anything that
// is neither: see migration 177, which is where the whitelists gained the
// second shape.
//
// The row stores the R2 key, never a URL. The URL is derived here, so a client
// that registers an asset cannot point the worker at a host of its choosing.

export type AssetKind = "sound" | "element";

export interface UserAsset {
  id: string;
  kind: AssetKind;
  name: string;
  url: string;
  mime: string;
  bytes: number;
  durationSec: number | null;
  createdAt: string;
}

interface AssetRow {
  id: string;
  kind: AssetKind;
  name: string;
  storage_key: string;
  mime: string;
  bytes: number;
  duration_sec: number | string | null;
  created_at: string;
}

const CUSTOM_PREFIX = "custom:";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True when this id names an uploaded asset rather than a built-in. */
export function isCustomRef(ref: string | null | undefined): boolean {
  return typeof ref === "string"
    && ref.startsWith(CUSTOM_PREFIX)
    && UUID.test(ref.slice(CUSTOM_PREFIX.length));
}

/** The asset id inside a custom ref, or null when this is not one. */
export function customIdOf(ref: string | null | undefined): string | null {
  return isCustomRef(ref) ? (ref as string).slice(CUSTOM_PREFIX.length) : null;
}

/** How an asset id is written into project_sounds, project_elements and
 *  project_beats.sound_effect. */
export function refForAsset(id: string): string {
  return `${CUSTOM_PREFIX}${id}`;
}

/**
 * What may be uploaded.
 *
 * Narrow on purpose. Every one of these decodes in the ffmpeg build the worker
 * ships, and an element has to carry alpha or it is a rectangle pasted over the
 * footage, which is why jpeg is not here.
 */
export const ASSET_RULES: Record<AssetKind, { mimes: string[]; maxBytes: number; label: string }> = {
  sound:   { mimes: ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/mp4", "audio/aac", "audio/ogg"], maxBytes: 5 * 1024 * 1024, label: "MP3, WAV, M4A or OGG up to 5 MB" },
  element: { mimes: ["image/png", "image/webp", "image/gif"], maxBytes: 5 * 1024 * 1024, label: "PNG, WebP or GIF up to 5 MB" },
};

function toAsset(r: AssetRow): UserAsset {
  return {
    id: r.id,
    kind: r.kind,
    name: r.name,
    url: getPublicUrl(r.storage_key),
    mime: r.mime,
    bytes: Number(r.bytes),
    durationSec: r.duration_sec === null ? null : Number(r.duration_sec),
    createdAt: r.created_at,
  };
}

/** Everything this user has uploaded, newest first. */
export async function listUserAssets(userId: string, kind?: AssetKind): Promise<UserAsset[]> {
  let q = supabase
    .from("user_assets")
    .select("id, kind, name, storage_key, mime, bytes, duration_sec, created_at")
    .eq("user_id", userId);
  if (kind) q = q.eq("kind", kind);
  const { data, error } = await q.order("created_at", { ascending: false });
  if (error) {
    console.warn("[user-assets] list failed:", error.message);
    return [];
  }
  return (data as unknown as AssetRow[]).map(toAsset);
}

/**
 * Resolve refs to assets, keyed by the ref as written.
 *
 * Takes the refs rather than bare ids so a caller can hand it a column
 * verbatim; built-in names are ignored rather than rejected, because a mixed
 * list is the normal case.
 */
export async function resolveCustomRefs(refs: (string | null | undefined)[]): Promise<Map<string, UserAsset>> {
  const ids = [...new Set(refs.map(customIdOf).filter((v): v is string => !!v))];
  const out = new Map<string, UserAsset>();
  if (!ids.length) return out;
  const { data, error } = await supabase
    .from("user_assets")
    .select("id, kind, name, storage_key, mime, bytes, duration_sec, created_at")
    .in("id", ids);
  if (error) {
    console.warn("[user-assets] resolve failed:", error.message);
    return out;
  }
  for (const row of data as unknown as AssetRow[]) out.set(refForAsset(row.id), toAsset(row));
  return out;
}

/** True when this ref is a built-in, or an upload this user owns. Anything
 *  else is somebody else's asset or a deleted one, and must not be attachable. */
export async function ownsRef(userId: string, ref: string): Promise<boolean> {
  const id = customIdOf(ref);
  if (!id) return false;
  const { data } = await supabase
    .from("user_assets").select("id").eq("id", id).eq("user_id", userId).maybeSingle();
  return !!data;
}
