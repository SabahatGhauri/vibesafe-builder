// Thin wrapper around SendGrid's HTTP API — plain fetch, no SDK dependency, matching
// this codebase's pattern of keeping the dependency list minimal (see package.json).
// Chosen over Resend: SendGrid's free tier includes domain verification for
// additional domains at no cost, where Resend gates a second verified domain
// behind a paid plan — relevant here since this account already has one domain
// verified elsewhere in the VibeSafe family.
// sendEmail() never throws — it swallows its own errors and returns { ok, error }
// instead, so a flaky or unconfigured email provider can never take down account
// activation or sign-in. Those are the real product; email is a nice-to-have on top.

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.MAIL_FROM_EMAIL || "hello@vibesafebuilder.com";
const FROM_NAME = process.env.MAIL_FROM_NAME || "VibeSafe Builder";

async function sendEmail({ to, subject, html }) {
  if (!SENDGRID_API_KEY) {
    console.warn("SENDGRID_API_KEY not set — skipping email:", subject, "to", to);
    return { ok: false, error: "not_configured" };
  }
  try {
    const r = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${SENDGRID_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: to }] }],
        from: { email: FROM_EMAIL, name: FROM_NAME },
        subject,
        content: [{ type: "text/html", value: html }],
      }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      console.error("SendGrid send failed:", r.status, body);
      return { ok: false, error: `sendgrid_${r.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error("SendGrid send error:", err);
    return { ok: false, error: err.message || "unknown" };
  }
}

function shell(bodyHtml) {
  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#0a0d11;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#0a0d11;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background:#141a21;border:1px solid #232b34;border-radius:16px;padding:36px 32px;">
        <tr><td>
          <div style="font-weight:700;font-size:15px;color:#8d9aa8;margin-bottom:24px;">&#9670; VibeSafe Builder</div>
          ${bodyHtml}
        </td></tr>
      </table>
      <div style="color:#5f6b78;font-size:11.5px;margin-top:20px;">VibeSafe Builder &middot; a product of SG Digital Ventures LLC</div>
    </td></tr>
  </table>
</body>
</html>`;
}

function button(url, label) {
  return `<a href="${url}" style="display:inline-block;background:linear-gradient(135deg,#35d99a,#22b88a);color:#04180f;font-weight:700;font-size:14px;text-decoration:none;padding:12px 24px;border-radius:10px;margin-top:8px;">${label}</a>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function welcomeEmailHtml({ name }) {
  const greeting = name ? `Hey ${escapeHtml(name)},` : "Hey there,";
  return shell(`
    <h1 style="color:#eef3f7;font-size:20px;margin:0 0 12px;">Welcome to VibeSafe Builder</h1>
    <p style="color:#eef3f7;font-size:14px;line-height:1.6;margin:0 0 16px;">${greeting}</p>
    <p style="color:#8d9aa8;font-size:14px;line-height:1.6;margin:0 0 16px;">
      You're all set. Describe the app you want in plain English and VibeSafe Builder writes it — with a cost estimate before every generation, a security scan on everything it builds, and one-click publishing when you're ready.
    </p>
    <p style="color:#8d9aa8;font-size:14px;line-height:1.6;margin:0 0 20px;">
      Bring your own Anthropic API key any time in Settings, or upgrade to the Managed plan and we handle the key for you.
    </p>
    ${button("https://vibesafebuilder.com/app", "Open the builder")}
  `);
}

function proActivationEmailHtml({ name, setPasswordUrl }) {
  const greeting = name ? `Hey ${escapeHtml(name)},` : "Hey there,";
  const action = setPasswordUrl
    ? `<p style="color:#8d9aa8;font-size:14px;line-height:1.6;margin:0 0 20px;">One last step — set a password so you can log back in any time:</p>${button(setPasswordUrl, "Set your password")}`
    : button("https://vibesafebuilder.com/app", "Open the builder");
  return shell(`
    <h1 style="color:#eef3f7;font-size:20px;margin:0 0 12px;">You're on the Pro plan &#127881;</h1>
    <p style="color:#eef3f7;font-size:14px;line-height:1.6;margin:0 0 16px;">${greeting}</p>
    <p style="color:#8d9aa8;font-size:14px;line-height:1.6;margin:0 0 16px;">
      Your payment went through and your account is now on the Managed plan — no API key needed, $10/mo of build budget included.
    </p>
    ${action}
  `);
}

module.exports = { sendEmail, welcomeEmailHtml, proActivationEmailHtml };
