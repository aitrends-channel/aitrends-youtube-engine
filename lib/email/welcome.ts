import { supabase } from "@/lib/supabase/client";
import { sendEmail } from "./smtp";
import { renderBulkMailHtml } from "./bulk-mail-template";
import { WELCOME_EMAIL_ENABLED } from "@/lib/feature-flags";

// Welcome email for a first-time paying customer, fired from whichever
// grant path lands the purchase (the Dodo verify route or the webhook).
// Both call shouldWelcome with the metadata as it was BEFORE the grant,
// then send; the stamp written here makes the other path — and every
// later renewal or upgrade — skip.

const FROM = "support@heclus.com";
const APP_URL = process.env.APP_URL ?? "https://app.heclus.io";

/**
 * Does this purchase earn a welcome email?
 *
 * Takes app_metadata as it was before the grant wrote to it. The stamp
 * alone is not a sufficient test: every customer who paid before this
 * email existed carries no stamp, so their next renewal would read as a
 * first purchase. Requiring that they were not already paying is what
 * separates a new subscriber from a renewal or an upgrade.
 */
export function shouldWelcome(prevAppMetadata: Record<string, unknown> | null | undefined): boolean {
  const prev = prevAppMetadata ?? {};
  if (prev.welcome_email_sent_at) return false;
  return prev.paid !== true;
}

function firstNameFrom(userMetadata: Record<string, unknown> | null | undefined): string {
  const raw = (userMetadata ?? {}).full_name ?? (userMetadata ?? {}).name ?? (userMetadata ?? {}).first_name;
  if (typeof raw === "string" && raw.trim()) return raw.trim().split(/\s+/)[0];
  return "there";
}

function planLabelFor(plan: string | null | undefined): string {
  const slug = (plan ?? "").trim();
  if (!slug) return "";
  return slug.charAt(0).toUpperCase() + slug.slice(1).toLowerCase();
}

export function buildWelcomeEmail(name: string, planLabel: string): { subject: string; text: string } {
  const plan = planLabel ? `${planLabel} plan` : "plan";
  return {
    subject: planLabel ? `Welcome to Heclus: your ${planLabel} plan is active` : "Welcome to Heclus",
    text: `Hello ${name},

Thank you for subscribing to Heclus. Your ${plan} is now active.

To get started, add your API key on the Config page, then paste a YouTube channel URL to create your first niche: ${APP_URL}

If you need any help, reply to this email and we will assist you directly.

Kind regards,

Alex
Heclus Support`,
  };
}

/**
 * Send the welcome email and stamp the account so it goes out once.
 *
 * Throws on SMTP failure — call sites treat that as fail-soft and log,
 * since the customer has already paid and a missing welcome must never
 * fail a purchase. The stamp is written after the send (a failed send
 * leaves no stamp, so the next payment event retries) and merges onto a
 * re-read of app_metadata so it cannot roll back the paid/plan/dodo
 * fields the grant just wrote.
 */
export async function sendWelcomeEmail(args: {
  userId: string;
  email: string;
  userMetadata?: Record<string, unknown> | null;
  plan?: string | null;
}): Promise<boolean> {
  if (!WELCOME_EMAIL_ENABLED) return false;

  const { subject, text } = buildWelcomeEmail(firstNameFrom(args.userMetadata), planLabelFor(args.plan));
  await sendEmail({ from: FROM, to: args.email, subject, text, html: renderBulkMailHtml(subject, text) });

  const { data, error } = await supabase.auth.admin.getUserById(args.userId);
  if (error || !data.user) {
    console.error(`[welcome-email] sent to ${args.email} but could not re-read user to stamp: ${error?.message ?? "no user"}`);
    return true;
  }
  const { error: stampErr } = await supabase.auth.admin.updateUserById(args.userId, {
    app_metadata: { ...data.user.app_metadata, welcome_email_sent_at: new Date().toISOString() },
  });
  if (stampErr) {
    // Email is out; only the "already welcomed" marker is missing, so a
    // later payment event could duplicate it. Loud enough to notice.
    console.error(`[welcome-email] sent to ${args.email} but stamp failed: ${stampErr.message}`);
  }
  return true;
}
