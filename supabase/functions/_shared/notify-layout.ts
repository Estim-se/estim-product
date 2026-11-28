// Branded HTML for estim's own Resend notifications, matching the Supabase auth email templates (logo, white card,
// dark pill button, fallback link, footer). Pure: no imports besides escaping, no network. Every dynamic value is
// HTML-escaped here, so callers pass plain text.
import { escapeHtml } from "./mail-format.ts";

export interface BrandedEmail {
  /** Hidden inbox preview line. */
  preheader: string;
  /** HTML entity for the round icon, e.g. "&#9993;&#65038;" (fixed strings only, never user input). */
  iconEntity: string;
  heading: string;
  /** Plain-text paragraphs; a paragraph may mark bold parts with **double asterisks**. */
  paragraphs: string[];
  button: { label: string; url: string };
  footer: string;
  /** App origin (https://app.estim.se) for the logo image. */
  appUrl: string;
}

const FONT = "font-family:Arial,Helvetica,sans-serif;";

function paragraphHtml(text: string): string {
  // Escape first, then turn **x** into <b>x</b>; the markers themselves contain no HTML.
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}

export function brandedEmailHtml(e: BrandedEmail): string {
  const url = escapeHtml(e.button.url);
  const logo = escapeHtml(`${e.appUrl.replace(/\/$/, "")}/email/logo.png`);
  const body = e.paragraphs
    .map((p) => `<p style="margin:10px 0 0 0;${FONT}font-size:15px;line-height:1.6;color:#4A4458;text-align:center;">${paragraphHtml(p)}</p>`)
    .join("");
  return `<!DOCTYPE html>
<html lang="sv">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(e.heading)}</title>
</head>
<body style="margin:0;padding:0;background-color:#F5F4EF;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(e.preheader)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F5F4EF;">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#FFFFFF;border:1px solid #EBE9E4;border-radius:12px;">
          <tr>
            <td align="center" style="padding:32px 40px 32px 40px;">
              <img src="${logo}" alt="estim" width="96" style="display:block;margin:0 auto;border:0;outline:none;height:auto;width:96px;${FONT}font-size:24px;font-weight:700;color:#2B2539;text-align:center;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px auto 0 auto;">
                <tr>
                  <td align="center" valign="middle" width="64" height="64" bgcolor="#EBE9E4" style="width:64px;height:64px;border-radius:32px;${FONT}font-size:28px;line-height:64px;font-weight:700;color:#2B2539;text-align:center;">${e.iconEntity}</td>
                </tr>
              </table>
              <h1 style="margin:20px 0 0 0;${FONT}font-size:28px;line-height:1.2;font-weight:700;color:#2B2539;letter-spacing:-0.5px;text-align:center;">${escapeHtml(e.heading)}</h1>
              <p style="margin:20px 0 0 0;${FONT}font-size:17px;line-height:1.4;font-weight:700;color:#2B2539;text-align:center;">Hej!</p>
              ${body}
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px auto 0 auto;">
                <tr>
                  <td align="center" bgcolor="#2B2539" style="border-radius:999px;">
                    <a href="${url}" style="display:inline-block;padding:14px 32px;${FONT}font-size:15px;font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:999px;">${escapeHtml(e.button.label)}</a>
                  </td>
                </tr>
              </table>
              <p style="margin:28px 0 0 0;padding-top:18px;border-top:1px solid #EBE9E4;${FONT}font-size:12px;line-height:1.6;color:#7B6767;text-align:center;">Fungerar inte knappen? Kopiera länken till webbläsaren:<br><a href="${url}" style="color:#2B2539;text-decoration:underline;word-break:break-all;">${url}</a></p>
            </td>
          </tr>
        </table>
        <p style="margin:20px 0 0 0;${FONT}font-size:12px;line-height:1.6;color:#7B6767;text-align:center;">${escapeHtml(e.footer)}</p>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
