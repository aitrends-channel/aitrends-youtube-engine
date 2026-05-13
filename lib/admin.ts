export const ADMIN_EMAILS = new Set(["prioritylearn@gmaill.com"]);

export function isAdminEmail(email: string | undefined | null): boolean {
  return !!email && ADMIN_EMAILS.has(email.toLowerCase());
}
