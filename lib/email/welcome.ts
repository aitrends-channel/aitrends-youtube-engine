import { supabase } from "@/lib/supabase/client";
import { sendEmail } from "./smtp";
import { renderBulkMailHtml } from "./bulk-mail-template";
import { WELCOME_EMAIL_ENABLED } from "@/lib/feature-flags";

// The two lifecycle emails, and the rules for sending each exactly once:
//
//   • signup   — a new account is usable (password set, or first OAuth
//                sign-in). Stamped signup_email_sent_at.
//   • purchase — a first-time plan purchase granted access, fired from
//                whichever grant path lands it (the Dodo verify route or
//                the webhook). Stamped welcome_email_sent_at.
//
// Both gates are written so they can never fire for an ESTABLISHED
// account: a stamp-only test would treat every user who predates these
// emails as brand new, and mail the whole existing base on their next
// sign-in or renewal.

const FROM = "support@heclus.com";
// Truthiness, not ??: an APP_URL set to an empty string would otherwise
// render the one link in this email as nothing at all.
const APP_URL = process.env.APP_URL?.trim() || "https://app.heclus.io";

// Marketing pricing page — heclus.io/pricing bounces to login (that host
// is the app), so the conversion link has to be the .com one, same as the
// founder template in bulk-mail-template-defaults.
const PRICING_URL = "https://heclus.com/pricing";

// The signup email only fires for an account this young. See
// shouldSendSignupEmail — this is the guard that keeps it off established
// accounts, which is what makes it safe on a path everyone passes through.
const SIGNUP_EMAIL_MAX_ACCOUNT_AGE_MS = 24 * 60 * 60 * 1000;

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

/**
 * Does this account earn the signup email?
 *
 * The account-age window is what makes this safe to run on a path every
 * user passes through. Without it, the 13 accounts that predate this
 * email carry no stamp and would each be "welcomed" on their next sign-in
 * or password reset. It also means a reset on an established account can
 * never trigger a welcome, whatever the caller claims.
 */
export function shouldSendSignupEmail(args: {
  createdAt: string | undefined;
  appMetadata: Record<string, unknown> | null | undefined;
}): boolean {
  const meta = args.appMetadata ?? {};
  if (meta.signup_email_sent_at) return false;
  // Already welcomed as a paying customer — one welcome is enough.
  if (meta.welcome_email_sent_at) return false;
  if (!args.createdAt) return false;
  const ageMs = Date.now() - new Date(args.createdAt).getTime();
  return Number.isFinite(ageMs) && ageMs >= 0 && ageMs < SIGNUP_EMAIL_MAX_ACCOUNT_AGE_MS;
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

  await stampSent(args.userId, args.email, "welcome_email_sent_at");
  return true;
}

// New accounts arrive unpaid, so this email must not send them to the
// Config page: without a plan they cannot run the pipeline, and asking for
// an API key first would be asking for work before any value. It welcomes
// them and points at the one thing that unlocks the product.
export function buildSignupEmail(name: string): { subject: string; text: string } {
  return {
    subject: "Welcome to Heclus",
    text: `Hello ${name},

Thank you for creating your Heclus account.

To start creating videos, choose a plan here: ${PRICING_URL}

If you have any questions, reply to this email and we will be glad to help.

Kind regards,

Heclus Support`,
  };
}

/**
 * Send the signup email and stamp the account so it goes out once.
 *
 * Throws on SMTP failure. Call sites treat that as fail-soft: a missing
 * welcome must never block someone getting into the app they just
 * created. Gate with shouldSendSignupEmail first.
 */
export async function sendSignupEmail(args: {
  userId: string;
  email: string;
  userMetadata?: Record<string, unknown> | null;
}): Promise<boolean> {
  if (!WELCOME_EMAIL_ENABLED) return false;

  const { subject, text } = buildSignupEmail(firstNameFrom(args.userMetadata));
  await sendEmail({ from: FROM, to: args.email, subject, text, html: renderBulkMailHtml(subject, text) });

  await stampSent(args.userId, args.email, "signup_email_sent_at");
  return true;
}

/**
 * Record that a lifecycle email went out.
 *
 * Merges onto a re-read of app_metadata rather than a copy the caller is
 * holding, so stamping can never roll back fields written between then
 * and now (the purchase path writes paid/plan/dodo just before this).
 * Never throws: the mail is already delivered, so a stamp failure must
 * not be reported as a send failure — it only risks a duplicate later,
 * which is logged loudly instead.
 */
async function stampSent(userId: string, email: string, field: string): Promise<void> {
  const { data, error } = await supabase.auth.admin.getUserById(userId);
  if (error || !data.user) {
    console.error(`[lifecycle-email] ${field}: sent to ${email} but could not re-read user to stamp: ${error?.message ?? "no user"}`);
    return;
  }
  const { error: stampErr } = await supabase.auth.admin.updateUserById(userId, {
    app_metadata: { ...data.user.app_metadata, [field]: new Date().toISOString() },
  });
  if (stampErr) {
    console.error(`[lifecycle-email] ${field}: sent to ${email} but stamp failed: ${stampErr.message}`);
  }
}
