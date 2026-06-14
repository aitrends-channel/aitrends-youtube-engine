import { ImapFlow } from "imapflow";
import { supabase } from "@/lib/supabase/client";

/**
 * IMAP poller backed by Hostinger.
 *
 * Connects to the INBOX, fetches every message UID we haven't seen
 * yet, parses headers + bodies via imapflow's built-in helpers, and
 * inserts new rows into the emails table.
 *
 * The cursor (last-seen UID) lives in product_config — a single row
 * keyed by service='_global' so the next poll picks up where the
 * previous one stopped. UIDVALIDITY changes (rare — mailbox rebuild,
 * format migration on Hostinger's side) reset the cursor to 0 so we
 * re-sync from scratch; the unique(message_id) constraint on emails
 * de-dups anything we already have.
 *
 * Fail-soft per-message: a single malformed message (weird encoding,
 * missing headers) shouldn't stop the whole sync. Errors are warned
 * and the next message tries.
 */

interface SyncStats {
  fetched: number;
  inserted: number;
  skipped: number;
  uidValidityReset: boolean;
}

interface ImapCursor {
  uid_validity: number;
  last_uid: number;
}

async function readCursor(): Promise<ImapCursor> {
  const { data } = await supabase
    .from("product_config")
    .select("imap_uid_validity, imap_last_uid")
    .eq("service", "_global")
    .single();
  return {
    uid_validity: Number(data?.imap_uid_validity ?? 0),
    last_uid: Number(data?.imap_last_uid ?? 0),
  };
}

async function writeCursor(cursor: ImapCursor): Promise<void> {
  const { error } = await supabase
    .from("product_config")
    .update({
      imap_uid_validity: cursor.uid_validity,
      imap_last_uid: cursor.last_uid,
    })
    .eq("service", "_global");
  if (error) {
    console.warn("[email/imap] failed to persist cursor:", error.message);
  }
}

function getClient(): ImapFlow {
  const host = process.env.HOSTINGER_IMAP_HOST;
  const portRaw = process.env.HOSTINGER_IMAP_PORT;
  const user = process.env.HOSTINGER_IMAP_USER;
  const pass = process.env.HOSTINGER_IMAP_PASS;

  if (!host || !portRaw || !user || !pass) {
    throw new Error("Hostinger IMAP env not configured (HOSTINGER_IMAP_HOST/PORT/USER/PASS).");
  }
  const port = Number(portRaw);
  if (!Number.isFinite(port)) {
    throw new Error(`HOSTINGER_IMAP_PORT must be a number, got ${portRaw}`);
  }

  return new ImapFlow({
    host,
    port,
    secure: port === 993,
    auth: { user, pass },
    // Suppress imapflow's chatty default logger; we surface errors
    // via console.warn ourselves on the call sites that care.
    logger: false,
  });
}

/**
 * Pull "From: First Last <addr@example.com>" → "addr@example.com".
 * Falls back to the raw value if there's no angle-bracket form.
 */
function extractAddress(raw: string | undefined | null): string {
  if (!raw) return "";
  const match = raw.match(/<([^>]+)>/);
  return (match ? match[1] : raw).trim();
}

function extractAddressList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  // Header allows comma-separated addresses, each possibly in
  // "Name <addr>" form. Split on commas that aren't inside angle
  // brackets (rare but addresses with names containing commas exist).
  // Cheap approach: split on commas, then extract each.
  return raw.split(",").map((p) => extractAddress(p)).filter(Boolean);
}

/**
 * Run one IMAP sync pass. Returns counts so the caller can log /
 * surface them. Caller should serialize calls — running two in
 * parallel would race on the cursor row.
 */
export async function syncInbox(): Promise<SyncStats> {
  const stats: SyncStats = { fetched: 0, inserted: 0, skipped: 0, uidValidityReset: false };
  const client = getClient();

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const mailbox = client.mailbox;
      if (!mailbox || typeof mailbox === "boolean") {
        throw new Error("INBOX did not open cleanly");
      }
      const serverUidValidity = Number(mailbox.uidValidity ?? 0);
      const cursor = await readCursor();

      let sinceUid = cursor.last_uid;
      if (cursor.uid_validity !== serverUidValidity) {
        // Hostinger remapped UIDs — our cursor is meaningless. Pull
        // everything; the unique(message_id) constraint will absorb
        // the dupes from the last cycle.
        stats.uidValidityReset = true;
        sinceUid = 0;
      }

      // Fetch UIDs strictly greater than sinceUid. ImapFlow's range
      // syntax: "N:*" means "from N to the end". Off-by-one fix:
      // start at sinceUid + 1 so we don't re-fetch the most recent
      // message every cycle.
      const range = `${sinceUid + 1}:*`;
      let highestSeenUid = sinceUid;

      for await (const msg of client.fetch(range, {
        uid: true,
        envelope: true,
        source: true,        // raw RFC 822 — we parse headers from this
        flags: true,
      }, { uid: true })) {
        stats.fetched++;
        try {
          const uid = Number(msg.uid);
          if (uid > highestSeenUid) highestSeenUid = uid;

          const env = msg.envelope;
          const messageId = env?.messageId ?? null;
          if (!messageId) {
            // No Message-ID — can't de-dup safely, skip.
            stats.skipped++;
            console.warn(`[email/imap] message uid=${uid} has no Message-ID; skipping`);
            continue;
          }

          // Parse the source for body. imapflow doesn't auto-parse
          // bodies; we ship the raw and let the UI render plain text
          // if HTML isn't present. Crude but adequate for v1 — most
          // mail is multipart/alternative and we just grab the text
          // part below.
          const rawSource = msg.source?.toString("utf-8") ?? "";
          const { text, html } = splitBody(rawSource);

          const from = env?.from?.[0];
          const fromAddress = from
            ? (from.address ?? "").trim() || (from.name ?? "").trim()
            : "";

          const toAddresses = (env?.to ?? []).map((a) => (a.address ?? "").trim()).filter(Boolean);
          const ccAddresses = (env?.cc ?? []).map((a) => (a.address ?? "").trim()).filter(Boolean);

          // Threading. In-Reply-To / References live in the header
          // block; envelope exposes inReplyTo for us.
          const inReplyTo = env?.inReplyTo ?? null;
          // Cheap thread_root_id: if we have an in_reply_to, walk it
          // by looking up the parent's thread_root_id. If parent isn't
          // in the DB yet, fall back to inReplyTo itself (will be
          // backfilled the next time the user opens the thread).
          let threadRootId = messageId;
          if (inReplyTo) {
            const { data: parent } = await supabase
              .from("emails")
              .select("thread_root_id")
              .eq("message_id", inReplyTo)
              .maybeSingle();
            threadRootId = parent?.thread_root_id ?? inReplyTo;
          }

          const receivedAt = env?.date ? new Date(env.date).toISOString() : null;

          const { error } = await supabase.from("emails").insert({
            direction: "inbound",
            message_id: messageId,
            in_reply_to: inReplyTo,
            thread_root_id: threadRootId,
            from_address: fromAddress,
            to_addresses: toAddresses,
            cc_addresses: ccAddresses,
            subject: env?.subject ?? null,
            body_text: text,
            body_html: html,
            received_at: receivedAt,
            is_read: false,
            imap_uid_validity: serverUidValidity,
            imap_uid: uid,
          });
          if (error) {
            // Most common: duplicate message_id (we already have it).
            // Treat as skip, not failure.
            if (error.code === "23505") {
              stats.skipped++;
            } else {
              console.warn(`[email/imap] insert failed uid=${uid}:`, error.message);
              stats.skipped++;
            }
          } else {
            stats.inserted++;
          }
        } catch (e) {
          stats.skipped++;
          console.warn(`[email/imap] error processing message:`, e instanceof Error ? e.message : e);
        }
      }

      // Persist the new high-water mark even if some messages
      // skipped — they're either dupes or unrecoverable, no point
      // re-fetching them next cycle.
      if (highestSeenUid > sinceUid || stats.uidValidityReset) {
        await writeCursor({ uid_validity: serverUidValidity, last_uid: highestSeenUid });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => { /* ignore — close the socket either way */ });
  }

  return stats;
}

/**
 * Naive multipart/alternative splitter. Looks for a text/plain part
 * and a text/html part, returns both if present. For single-part
 * messages, returns the whole body as text. This is intentionally
 * cheap — we don't decode quoted-printable or base64 yet (most
 * modern mail is 8bit/utf-8 and renders correctly). If you start
 * seeing garbled inbound, swap in a real MIME parser like mailparser.
 */
function splitBody(raw: string): { text: string | null; html: string | null } {
  // Find the blank line that separates headers from body.
  const sep = raw.indexOf("\r\n\r\n");
  const bodyStart = sep === -1 ? raw.indexOf("\n\n") : sep;
  if (bodyStart === -1) return { text: null, html: null };

  const body = raw.slice(bodyStart + (sep === -1 ? 2 : 4));
  // Detect a multipart boundary in the parent Content-Type header.
  const headers = raw.slice(0, bodyStart);
  const boundaryMatch = headers.match(/boundary="?([^"\s;]+)"?/i);
  if (!boundaryMatch) {
    // Single-part. Pick text or html by Content-Type, default to text.
    const isHtml = /content-type:\s*text\/html/i.test(headers);
    return isHtml ? { text: null, html: body.trim() } : { text: body.trim(), html: null };
  }

  const boundary = boundaryMatch[1];
  const parts = body.split(new RegExp(`--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:--)?`));
  let text: string | null = null;
  let html: string | null = null;
  for (const part of parts) {
    if (!part.trim()) continue;
    const partSep = part.indexOf("\r\n\r\n");
    const partBodyStart = partSep === -1 ? part.indexOf("\n\n") : partSep;
    if (partBodyStart === -1) continue;
    const partHeaders = part.slice(0, partBodyStart);
    const partBody = part.slice(partBodyStart + (partSep === -1 ? 2 : 4)).trim();
    if (/content-type:\s*text\/plain/i.test(partHeaders) && !text) {
      text = partBody;
    } else if (/content-type:\s*text\/html/i.test(partHeaders) && !html) {
      html = partBody;
    }
  }
  return { text, html };
}
