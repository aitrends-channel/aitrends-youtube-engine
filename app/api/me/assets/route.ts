export const dynamic = "force-dynamic";
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { getRequiredUser } from "@/lib/supabase/auth";
import type { User } from "@supabase/supabase-js";
import { meetsTier, tierLabel } from "@/lib/plans-gating";
import { userFolderFor, objectExists, deleteObject } from "@/lib/supabase/storage";
import { listUserAssets, ASSET_RULES, type AssetKind } from "@/lib/user-assets";

// The customer's own sound effects and elements.
//
//   GET    ?kind=sound|element   what they have uploaded
//   POST   { kind, name, storageKey, mime, bytes, durationSec }
//   DELETE ?id=…
//
// The file itself goes straight to R2 through /api/upload/presign, which is
// what keeps a 5 MB upload off a route handler. This registers the result.
//
// Uploading is a Max feature. Rendering is not: a placement that already exists
// keeps working if the plan lapses, because silently dropping a sound out of a
// video somebody already assembled is a worse answer than letting it play.

const UPLOAD_TIER = "max" as const;

function gate(user: User) {
  if (meetsTier(user, UPLOAD_TIER)) return null;
  return NextResponse.json(
    {
      error: `Custom sounds and elements are part of the ${tierLabel(UPLOAD_TIER)} plan.`,
      code: "PLAN_REQUIRED",
      requiredPlan: UPLOAD_TIER,
    },
    { status: 403 },
  );
}

const isKind = (v: unknown): v is AssetKind => v === "sound" || v === "element";

export async function GET(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const kindParam = new URL(req.url).searchParams.get("kind");
  const kind = isKind(kindParam) ? kindParam : undefined;
  const assets = await listUserAssets(user.id, kind);
  // canUpload rather than a 403: the picker still lists what a lapsed account
  // already owns, and only the upload control is withheld.
  return NextResponse.json({ assets, canUpload: meetsTier(user, UPLOAD_TIER) });
}

export async function POST(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }
  const denied = gate(user);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const kind = body.kind;
  if (!isKind(kind)) return NextResponse.json({ error: "kind must be sound or element" }, { status: 400 });
  const rules = ASSET_RULES[kind];

  const name = typeof body.name === "string" ? body.name.trim().slice(0, 60) : "";
  if (!name) return NextResponse.json({ error: "name is required" }, { status: 400 });

  const mime = typeof body.mime === "string" ? body.mime.toLowerCase() : "";
  if (!rules.mimes.includes(mime)) {
    return NextResponse.json({ error: `A ${kind} must be ${rules.label}` }, { status: 400 });
  }

  const bytes = typeof body.bytes === "number" && Number.isFinite(body.bytes) ? Math.round(body.bytes) : 0;
  if (bytes <= 0) return NextResponse.json({ error: "bytes is required" }, { status: 400 });
  if (bytes > rules.maxBytes) {
    return NextResponse.json({ error: `Too large. A ${kind} must be ${rules.label}` }, { status: 400 });
  }

  // The key has to be under this account's own folder. Without this check a
  // caller could register any object in the bucket as their own asset, and the
  // worker would then fetch and render it.
  const storageKey = typeof body.storageKey === "string" ? body.storageKey : "";
  const prefix = `${userFolderFor(user)}/`;
  if (!storageKey.startsWith(prefix) || storageKey.includes("..")) {
    return NextResponse.json({ error: "storageKey is not in this account's folder" }, { status: 400 });
  }
  // And it has to exist. A row pointing at nothing is a picker entry that
  // renders as silence with no explanation.
  if (!(await objectExists(storageKey))) {
    return NextResponse.json({ error: "The upload did not complete. Try again." }, { status: 400 });
  }

  const durationSec = typeof body.durationSec === "number" && Number.isFinite(body.durationSec) && body.durationSec > 0
    ? Math.round(body.durationSec * 1000) / 1000
    : null;

  const { data, error } = await supabase
    .from("user_assets")
    // The unique index on storage_key makes a retried registration idempotent
    // rather than a second row billed against the same object.
    .upsert({
      user_id: user.id, kind, name, storage_key: storageKey, mime, bytes, duration_sec: durationSec,
    }, { onConflict: "storage_key" })
    .select("id")
    .single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const assets = await listUserAssets(user.id, kind);
  return NextResponse.json({ id: data.id, assets });
}

export async function DELETE(req: Request) {
  let user: User;
  try { user = await getRequiredUser(); } catch (e) { return e as Response; }

  const id = new URL(req.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  // Scoped to the owner, so a guessed id deletes nothing.
  const { data: row } = await supabase
    .from("user_assets").select("storage_key").eq("id", id).eq("user_id", user.id).maybeSingle();
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { error } = await supabase.from("user_assets").delete().eq("id", id).eq("user_id", user.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // After the row, and best effort. An orphaned object costs storage; a row
  // whose object is already gone renders as silence, which is worse.
  try { await deleteObject((row as { storage_key: string }).storage_key); }
  catch (e) { console.warn("[user-assets] object delete failed:", e instanceof Error ? e.message : e); }

  return NextResponse.json({ ok: true });
}
