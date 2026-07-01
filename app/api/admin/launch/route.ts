import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { requireAdmin } from "@/lib/admin-server";
import { deleteFolder } from "@/lib/supabase/storage";
import { redis } from "@/lib/queue/client";
import { launchAllowed } from "@/lib/env";

// One-shot launch action. Wired to the admin Launch modal — the
// admin gathers their choices across tabs (which users to keep,
// whether to wipe logs, whether to reset the activity chart) and
// POSTs them here. Each step is independent and runs in order so a
// failure mid-way leaves a clear partial state rather than a half-
// done cascade.
//
// Steps, in execution order:
//   1. Delete every auth.users row whose email isn't in
//      excludeEmails. Cascades cleanly via existing FKs
//      (projects, account_settings, project_costs, etc.).
//   2. If clearLogs: truncate system_logs.
//   3. If clearActivity: set product_config._global.activity_cutoff_at
//      to now() — the admin Stats activity chart filters older rows
//      from then on.
//   4. Always: flip product_config._global.dodo_payment_mode to
//      'production' (the whole point of the action).
//
// Returns per-step result so the modal can show a checklist of what
// landed. Caller (LaunchModal) decides how to surface partial fails.

export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface LaunchPayload {
  excludeEmails?: unknown;
  clearLogs?: unknown;
  clearActivity?: unknown;
  resetFounderSlots?: unknown;
  clearEmails?: unknown;
}

interface StepResult {
  step: string;
  ok: boolean;
  detail?: string;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export async function POST(req: Request) {
  const guard = await requireAdmin();
  if (!guard.ok) return guard.response;

  // Hard environment gate. The Launch action is irreversible — so
  // we only allow it on the live prod deployment OR on a local dev
  // server (where NODE_ENV=development). Vercel-deployed staging is
  // refused: there NODE_ENV=production but HECLUS_ENV is unset, so
  // an admin signed into staging.heclus.io can't trigger a wipe.
  if (!launchAllowed()) {
    return NextResponse.json(
      {
        error: "Launch is disabled outside production. This deployment doesn't have HECLUS_ENV=production.",
        code: "not_production",
      },
      { status: 403 },
    );
  }

  let body: LaunchPayload;
  try { body = (await req.json()) as LaunchPayload; }
  catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }

  const excludeEmailsRaw = isStringArray(body.excludeEmails) ? body.excludeEmails : [];
  const excludeEmails = new Set(excludeEmailsRaw.map((e) => e.toLowerCase().trim()));
  const clearLogs = body.clearLogs === true;
  const clearActivity = body.clearActivity === true;
  const resetFounderSlots = body.resetFounderSlots === true;
  const clearEmails = body.clearEmails === true;

  const results: StepResult[] = [];

  // ── Step 1: delete non-excluded users ───────────────────────────
  // Tracks excluded user IDs (for the project_costs cleanup below)
  // and the emails + project IDs of the users we delete (for the R2
  // and Redis cleanup steps further down). Project IDs are pulled
  // BEFORE the delete loop because the cascade would otherwise wipe
  // them out of the projects table before we can read them.
  const excludedUserIds: string[] = [];
  const excludedUserEmails: string[] = [];
  const deletedUserEmails: string[] = [];
  const deletedProjectIds: string[] = [];
  try {
    const { data: usersData, error: listErr } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    if (listErr) throw new Error(`listUsers failed: ${listErr.message}`);
    const allUsers = usersData?.users ?? [];

    // Partition the user list first so we know which IDs to look up
    // projects for. Doing this in one pass also lets us collect the
    // emails for R2 folder cleanup later.
    const toDelete: { id: string; email: string }[] = [];
    for (const u of allUsers) {
      const email = u.email?.toLowerCase() ?? "";
      if (email && excludeEmails.has(email)) {
        excludedUserIds.push(u.id);
        excludedUserEmails.push(email);
        continue;
      }
      toDelete.push({ id: u.id, email });
    }

    // Project IDs owned by users we're about to delete — saved now
    // so the R2 + Redis cleanup steps still have them after the
    // auth.users cascade flushes the projects table.
    if (toDelete.length > 0) {
      const { data: projRows, error: projErr } = await supabase
        .from("projects")
        .select("id")
        .in("user_id", toDelete.map((u) => u.id));
      if (projErr) {
        console.warn("[launch] project-id collection failed:", projErr.message);
      } else {
        for (const p of (projRows ?? []) as { id: string }[]) {
          deletedProjectIds.push(p.id);
        }
      }
    }

    let deleted = 0;
    const failures: string[] = [];
    for (const u of toDelete) {
      const { error: delErr } = await supabase.auth.admin.deleteUser(u.id);
      if (delErr) {
        failures.push(`${u.email || u.id}: ${delErr.message}`);
      } else {
        deleted++;
        if (u.email) deletedUserEmails.push(u.email);
      }
    }

    const skipped = excludedUserIds.length;
    const detail = `deleted=${deleted}, kept=${skipped}, projects collected=${deletedProjectIds.length}` + (failures.length ? `, failed=${failures.length} (${failures.slice(0, 3).join("; ")}${failures.length > 3 ? "…" : ""})` : "");
    results.push({ step: "delete-users", ok: failures.length === 0, detail });
  } catch (err) {
    results.push({ step: "delete-users", ok: false, detail: err instanceof Error ? err.message : "unknown error" });
  }

  // ── Step 1b: explicitly wipe project_costs for anyone not in
  // the keep list. The cascades from step 1 (auth.users → projects
  // → project_costs) already handle the common case, but
  // project_costs.user_id has no foreign key — so any rows where the
  // project_id was already orphaned would survive without this. This
  // also serves as a guarantee that day-1 metrics start clean.
  try {
    const query = supabase.from("project_costs").delete();
    const { error } = excludedUserIds.length === 0
      ? await query.not("id", "is", null)
      : await query.not("user_id", "in", `(${excludedUserIds.join(",")})`);
    if (error) throw new Error(error.message);
    results.push({ step: "clear-project-costs", ok: true, detail: `kept rows for ${excludedUserIds.length} excluded user(s)` });
  } catch (err) {
    results.push({ step: "clear-project-costs", ok: false, detail: err instanceof Error ? err.message : "unknown error" });
  }

  // ── Step 1c: wipe R2 folders for every deleted user ────────────
  // R2 keys follow the `<email>/<projectId>/...` pattern (see
  // userFolderFor in lib/supabase/storage.ts). Per-user wipe covers
  // every asset they ever generated — images, voiceovers, assembled
  // MP4s, thumbnails, scratch uploads. Best-effort: one failed
  // folder doesn't tank the launch; the rest still get cleaned and
  // the failure is captured in the per-step detail.
  if (deletedUserEmails.length > 0) {
    let r2Cleaned = 0;
    const r2Failures: string[] = [];
    for (const email of deletedUserEmails) {
      try {
        await deleteFolder(`${email}/`);
        r2Cleaned++;
      } catch (err) {
        r2Failures.push(`${email}: ${err instanceof Error ? err.message : "unknown"}`);
      }
    }
    const detail = `wiped=${r2Cleaned} user folder(s)` + (r2Failures.length ? `, failed=${r2Failures.length} (${r2Failures.slice(0, 3).join("; ")}${r2Failures.length > 3 ? "…" : ""})` : "");
    results.push({ step: "clear-r2", ok: r2Failures.length === 0, detail });
  } else {
    results.push({ step: "clear-r2", ok: true, detail: "no users deleted, nothing to wipe" });
  }

  // ── Step 1d: drop assembly cache entries for deleted projects ──
  // The only Redis state our app holds is per-project assembly
  // options under `assembly:<projectId>` (TTL 7200s). They'd
  // self-expire within 2 hours regardless, but clearing them now
  // prevents a stray worker pickup from seeing stale options for a
  // project whose DB row was just deleted.
  if (deletedProjectIds.length > 0) {
    try {
      const keys = deletedProjectIds.map((id) => `assembly:${id}`);
      // @upstash/redis supports variadic del(...keys) — single
      // round-trip even for a few hundred keys. If the list gets
      // huge later, batch in chunks of 1000.
      const removed = await redis.del(...keys);
      results.push({ step: "clear-redis", ok: true, detail: `deleted=${removed} key(s) across ${deletedProjectIds.length} project(s)` });
    } catch (err) {
      results.push({ step: "clear-redis", ok: false, detail: err instanceof Error ? err.message : "unknown error" });
    }
  } else {
    results.push({ step: "clear-redis", ok: true, detail: "no projects deleted, nothing to drop" });
  }

  // ── Step 1e: wipe niches, videos & files for EXCLUDED users ────
  // Excluded users keep their auth.users row (so their login,
  // account_settings + API keys, and any subscription state survive),
  // but every asset they created during pre-launch testing gets
  // deleted so day-1 metrics are clean and no test video lingers in
  // their account:
  //   • projects (cascades → project_beats, project_costs)
  //   • R2 folder for the user's email
  //   • assembly:<projectId> Redis cache entries
  //   • niches_used counter reset to 0 so their post-launch niche
  //     allocation starts fresh
  if (excludedUserIds.length > 0) {
    try {
      // Collect project IDs BEFORE the delete cascade blanks the
      // projects table — needed for the Redis cleanup below.
      const { data: excludedProjRows, error: projErr } = await supabase
        .from("projects")
        .select("id")
        .in("user_id", excludedUserIds);
      if (projErr) throw new Error(`project-id collection failed: ${projErr.message}`);
      const excludedProjectIds = ((excludedProjRows ?? []) as { id: string }[]).map((p) => p.id);

      // Delete projects — cascade wipes project_beats + project_costs.
      const { error: delProjErr } = await supabase
        .from("projects")
        .delete()
        .in("user_id", excludedUserIds);
      if (delProjErr) throw new Error(`projects delete failed: ${delProjErr.message}`);

      // Wipe R2 folders. Best-effort per email — a single failed
      // folder shouldn't collapse the step.
      let r2Cleaned = 0;
      const r2Failures: string[] = [];
      for (const email of excludedUserEmails) {
        try {
          await deleteFolder(`${email}/`);
          r2Cleaned++;
        } catch (err) {
          r2Failures.push(`${email}: ${err instanceof Error ? err.message : "unknown"}`);
        }
      }

      // Drop assembly cache keys for the deleted projects.
      let redisRemoved = 0;
      if (excludedProjectIds.length > 0) {
        const keys = excludedProjectIds.map((id) => `assembly:${id}`);
        redisRemoved = await redis.del(...keys);
      }

      // Reset the niches_used counter so their post-launch cap starts
      // clean. account_settings row itself is preserved.
      const { error: settingsErr } = await supabase
        .from("account_settings")
        .update({ niches_used: 0 })
        .in("user_id", excludedUserIds);
      if (settingsErr) console.warn("[launch] niches_used reset failed:", settingsErr.message);

      const detail = `users=${excludedUserIds.length}, projects=${excludedProjectIds.length}, r2=${r2Cleaned}, redis=${redisRemoved}` +
        (r2Failures.length ? `, r2 failed=${r2Failures.length} (${r2Failures.slice(0, 3).join("; ")}${r2Failures.length > 3 ? "…" : ""})` : "");
      results.push({ step: "clear-excluded-content", ok: r2Failures.length === 0, detail });
    } catch (err) {
      results.push({ step: "clear-excluded-content", ok: false, detail: err instanceof Error ? err.message : "unknown error" });
    }
  } else {
    results.push({ step: "clear-excluded-content", ok: true, detail: "no excluded users, nothing to wipe" });
  }

  // ── Step 2: optionally truncate system_logs ────────────────────
  if (clearLogs) {
    try {
      // Supabase JS doesn't expose TRUNCATE — use delete with a
      // perma-true predicate (created_at is NOT NULL on every row).
      const { error } = await supabase.from("system_logs").delete().not("id", "is", null);
      if (error) throw new Error(error.message);
      results.push({ step: "clear-logs", ok: true });
    } catch (err) {
      results.push({ step: "clear-logs", ok: false, detail: err instanceof Error ? err.message : "unknown error" });
    }
  }

  // ── Step 3: optionally set activity cutoff ─────────────────────
  if (clearActivity) {
    try {
      const now = new Date().toISOString();
      const { error } = await supabase
        .from("product_config")
        .update({ activity_cutoff_at: now })
        .eq("service", "_global");
      if (error) throw new Error(error.message);
      results.push({ step: "clear-activity", ok: true, detail: `cutoff=${now}` });
    } catch (err) {
      results.push({ step: "clear-activity", ok: false, detail: err instanceof Error ? err.message : "unknown error" });
    }
  }

  // ── Step 3b: optionally reset founder promo slots ──────────────
  // Resets the counter on product_config._global, re-arms the promo,
  // and clears the claims log so day-1 founders see the full 100-spot
  // allotment instead of whatever count dev/test runs accumulated.
  if (resetFounderSlots) {
    try {
      const { error: cfgErr } = await supabase
        .from("product_config")
        .update({ founders_subscriptions_count: 0, founders_promo_active: true })
        .eq("service", "_global");
      if (cfgErr) throw new Error(cfgErr.message);

      // founder_claims_log uses payment_id as a natural key with no
      // catch-all "true" predicate available in supabase-js. Use a
      // perma-non-null guard on the primary key column instead.
      const { error: logErr } = await supabase
        .from("founder_claims_log")
        .delete()
        .not("payment_id", "is", null);
      if (logErr) throw new Error(logErr.message);

      results.push({ step: "reset-founder-slots", ok: true });
    } catch (err) {
      results.push({ step: "reset-founder-slots", ok: false, detail: err instanceof Error ? err.message : "unknown error" });
    }
  }

  // ── Step 3c: optionally clear emails ───────────────────────────
  if (clearEmails) {
    try {
      const { error } = await supabase
        .from("emails")
        .delete()
        .not("id", "is", null);
      if (error) throw new Error(error.message);
      results.push({ step: "clear-emails", ok: true });
    } catch (err) {
      results.push({ step: "clear-emails", ok: false, detail: err instanceof Error ? err.message : "unknown error" });
    }
  }

  // ── Step 4: flip Dodo payment mode to production ───────────────
  try {
    const { error } = await supabase
      .from("product_config")
      .update({ dodo_payment_mode: "production" })
      .eq("service", "_global");
    if (error) throw new Error(error.message);
    results.push({ step: "flip-payment-mode", ok: true, detail: "mode=production" });
  } catch (err) {
    results.push({ step: "flip-payment-mode", ok: false, detail: err instanceof Error ? err.message : "unknown error" });
  }

  const allOk = results.every((r) => r.ok);
  return NextResponse.json({ ok: allOk, results }, { status: allOk ? 200 : 207 });
}
