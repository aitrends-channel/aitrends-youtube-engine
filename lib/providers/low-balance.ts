import { supabase } from "@/lib/supabase/client";
import { sendEmail } from "@/lib/email/smtp";
import { ADMIN_EMAILS } from "@/lib/admin";
import { logSystemEvent } from "@/lib/system-logger";

// Telling somebody the PoYo account is running out, before it does.
//
// Generation stops dead at 80 credits: assertProviderFunded refuses every
// image submit below that floor, and the customer sees a 503 they can do
// nothing about. Nothing watched the number, so the first sign of an empty
// account has always been a customer failing to generate.
//
// The threshold is deliberately well above the floor. An alert that fires as
// the floor is crossed is a report of an outage, not a warning: PoYo is topped
// up by hand, which takes minutes at best and hours if it lands overnight.

/** Alert below this many PoYo credits.
 *
 *  Twenty-five times the hard floor of 80, and several days of image generation at
 *  the busiest we have been, because topping PoYo up is a manual job: the point
 *  of the warning is that it arrives while there is still time to act on it in
 *  working hours. Override with POYO_LOW_BALANCE_CREDITS. */
export const POYO_LOW_BALANCE = Number(process.env.POYO_LOW_BALANCE_CREDITS ?? 2000);

/** How long to stay quiet after alerting. The balance is read hourly; without
 *  this, an account left low would send a mail every hour until somebody paid,
 *  which is how an alert becomes something people filter out. */
const QUIET_HOURS = 6;

const SOURCE = "provider-balance";

/** Every admin who should hear about it: the data-driven flag, plus the legacy
 *  set so the founder admin is never left off. */
async function adminRecipients(): Promise<string[]> {
  const out = new Set<string>(ADMIN_EMAILS);
  try {
    const { data } = await supabase.auth.admin.listUsers({ perPage: 1000 });
    for (const u of data?.users ?? []) {
      const flag = (u.app_metadata as { is_admin?: unknown } | undefined)?.is_admin;
      if (flag === true && u.email) out.add(u.email.toLowerCase());
    }
  } catch {
    // The legacy address alone still reaches somebody, which is the point.
  }
  return [...out];
}

/** Whether an alert for this provider has already gone out recently. */
async function alertedRecently(provider: string): Promise<boolean> {
  const since = new Date(Date.now() - QUIET_HOURS * 3_600_000).toISOString();
  const { data, error } = await supabase
    .from("system_logs")
    .select("id")
    .eq("source", SOURCE)
    .eq("level", "warn")
    .ilike("message", `${provider}%`)
    .gte("created_at", since)
    .limit(1);
  // On an unreadable log, send. A duplicate warning is a smaller failure than
  // a silence nobody notices.
  if (error) return false;
  return !!data?.length;
}

/**
 * Warn the admins if PoYo is below the threshold.
 *
 * Called from the hourly snapshot, which already has the number, so this costs
 * one log read and, at most, one mail every six hours.
 *
 * Returns what it did, for the cron's own line in the runs table.
 */
export async function alertIfLowBalance(
  provider: string, credits: number | null, threshold = POYO_LOW_BALANCE,
): Promise<"sent" | "quiet" | "ok" | "unknown"> {
  if (credits === null) return "unknown";
  if (credits > threshold) return "ok";
  if (await alertedRecently(provider)) return "quiet";

  const to = await adminRecipients();
  const amount = credits.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const subject = `Heclus: ${provider} balance down to ${amount} credits`;
  const body =
    `The ${provider} account is at ${amount} credits, below the ${threshold} alert threshold.\n\n` +
    `Image generation stops entirely at 80 credits: every submit is refused and customers ` +
    `see a provider error they cannot act on.\n\n` +
    `Top up at https://poyo.ai/ , or move the image surface to another provider in ` +
    `Admin, Config, Operators.\n\n` +
    `Balances: https://app.heclus.io/admin (Providers)\n`;

  try {
    await sendEmail({
      from: process.env.HOSTINGER_SMTP_USER ?? "info@heclus.com",
      to,
      subject,
      text: body,
    });
  } catch (e) {
    // A failed mail must not fail the snapshot it rides on, but it does have to
    // be visible: this is the alert nobody would otherwise miss.
    console.error(`[provider-balance] alert mail failed:`, e instanceof Error ? e.message : e);
    await logSystemEvent({
      level: "error", source: SOURCE,
      message: `${provider} is at ${amount} credits and the alert mail failed to send`,
      metadata: { provider, credits, threshold },
    });
    return "sent";
  }

  await logSystemEvent({
    level: "warn", source: SOURCE,
    message: `${provider} balance low: ${amount} credits, alerted ${to.length} admin${to.length === 1 ? "" : "s"}`,
    metadata: { provider, credits, threshold, recipients: to },
  });
  return "sent";
}
