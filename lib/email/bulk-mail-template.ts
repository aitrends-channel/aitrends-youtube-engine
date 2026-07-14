// Branded HTML wrapper for admin bulk-mail sends. Mirrors the invite
// email shell in lib/email.ts — dark background, Heclus logo, purple
// accent — so support outreach matches the product's look. The admin's
// plain-text body is HTML-escaped with line breaks preserved; the raw
// text is still sent as the `text` part (fallback for non-HTML clients).

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Substitute per-recipient tokens. {{name}} → first name; {{video}} (or
// {{videos}}) → "video"/"videos" based on how many stuck videos the
// recipient has. Used at send time and in the admin preview (with a
// sample recipient). Case-insensitive, tolerant of inner spaces.
export function personalizeBulkMail(text: string, name: string, videoCount = 1): string {
  return text
    .replace(/\{\{\s*name\s*\}\}/gi, name)
    .replace(/\{\{\s*videos?\s*\}\}/gi, videoCount === 1 ? "video" : "videos");
}

// Step-based completion %. current_state can't distinguish Topic/Script
// (both 6) or Voiceover/Generate (both 14), so the *step label* is passed
// in from the selected phase rather than derived here.
export function progressPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round((n / 16) * 100)));
}

export interface BulkMailVideoRow {
  title: string;
  currentState: number;
  /** Per-row step label; falls back to the table-wide `step` when unset. */
  step?: string;
}

// Branded, email-safe table of the recipient's own stuck videos. Capped
// so a user with many abandoned drafts doesn't get an enormous table.
// `step` is the fallback label (the selected phase) for rows without
// their own — "any"-audience rows carry a resolved per-row step.
const MAX_TABLE_ROWS = 12;
function renderVideoTable(videos: BulkMailVideoRow[], step: string): string {
  if (videos.length === 0) return "";
  const shown = videos.slice(0, MAX_TABLE_ROWS);
  const extra = videos.length - shown.length;
  const moreRow = extra > 0
    ? `
                <tr>
                  <td colspan="3" style="padding:10px 12px;font-size:12px;color:#8a8a8a;border-top:1px solid rgba(255,255,255,0.06);">+ ${extra} more video${extra === 1 ? "" : "s"}</td>
                </tr>`
    : "";
  const rows = shown
    .map((v) => {
      const pct = progressPct(v.currentState);
      return `
                <tr>
                  <td style="padding:11px 12px;font-size:13px;color:#dcdcdc;border-top:1px solid rgba(255,255,255,0.06);">${escapeHtml(v.title)}</td>
                  <td style="padding:11px 12px;font-size:13px;color:#a0a0a0;border-top:1px solid rgba(255,255,255,0.06);white-space:nowrap;">${escapeHtml(v.step || step)}</td>
                  <td style="padding:11px 12px;border-top:1px solid rgba(255,255,255,0.06);white-space:nowrap;">
                    <table cellpadding="0" cellspacing="0" border="0" style="display:inline-block;width:52px;background:#2a2a2a;border-radius:4px;vertical-align:middle;">
                      <tr><td style="width:${pct}%;height:6px;background:#8b6cf7;border-radius:4px;font-size:0;line-height:0;">&nbsp;</td></tr>
                    </table>
                    <span style="font-size:12px;color:#a0a0a0;padding-left:8px;vertical-align:middle;">${pct}%</span>
                  </td>
                </tr>`;
    })
    .join("");

  return `
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:26px;border-collapse:collapse;border:1px solid rgba(255,255,255,0.08);border-radius:10px;overflow:hidden;">
                <tr style="background-color:#171717;">
                  <th align="left" style="padding:9px 12px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#8a8a8a;font-weight:600;">Title</th>
                  <th align="left" style="padding:9px 12px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#8a8a8a;font-weight:600;">Step</th>
                  <th align="left" style="padding:9px 12px;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#8a8a8a;font-weight:600;">Progress</th>
                </tr>${rows}${moreRow}
              </table>`;
}

export function renderBulkMailHtml(
  subject: string,
  bodyText: string,
  videos: BulkMailVideoRow[] = [],
  step = "",
): string {
  const heading = escapeHtml(subject);
  const body = escapeHtml(bodyText).replace(/\r?\n/g, "<br>");
  const table = renderVideoTable(videos, step);
  const year = new Date().getFullYear();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${heading}</title>
</head>
<body style="margin:0;padding:0;background-color:#080808;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">

  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#080808;min-height:100vh;">
    <tr>
      <td align="center" valign="top" style="padding:48px 16px 64px;">

        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">

          <!-- Logo -->
          <tr>
            <td align="center" style="padding-bottom:36px;">
              <img src="https://app.heclus.io/heclus-icon-white.png" alt="Heclus" width="72" height="72"
                style="display:block;border-radius:16px;" />
              <p style="margin:16px 0 0;font-size:17px;font-weight:700;color:#e8e8e8;letter-spacing:0.2px;">
                Heclus
              </p>
            </td>
          </tr>

          <!-- Card -->
          <tr>
            <td style="background-color:#111111;border-radius:20px;border:1px solid rgba(255,255,255,0.07);overflow:hidden;">

              <!-- Accent bar -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="height:3px;background:linear-gradient(90deg,#7c5cbf,#9b7ff5,#7c5cbf);font-size:0;line-height:0;">&nbsp;</td>
                </tr>
              </table>

              <!-- Body -->
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="padding:34px 22px 30px;">
                    <p style="margin:0 0 20px;font-size:22px;font-weight:700;color:#ebebeb;letter-spacing:-0.4px;line-height:1.3;">
                      ${heading}
                    </p>
                    <div style="font-size:15px;color:#c4c4c4;line-height:1.75;">
                      ${body}
                    </div>${table}
                  </td>
                </tr>
              </table>

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td align="center" style="padding-top:32px;">
              <p style="margin:0;font-size:11px;color:#2e2e2e;">
                &copy; ${year} Heclus &nbsp;&middot;&nbsp; <a href="https://www.heclus.io" style="color:#444;text-decoration:none;">www.heclus.io</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;
}
