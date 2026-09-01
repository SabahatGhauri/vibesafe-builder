// Thin wrapper around Resend's HTTP API — plain fetch, no SDK dependency, matching
// this codebase's pattern of keeping the dependency list minimal (see package.json).
// Moved here from SendGrid on 2026-08-19: SendGrid was originally chosen because
// this account's existing Resend domain-verification slot was already used by a
// different VibeSafe product. This is a SEPARATE Resend account with its own
// verified domain, so that constraint doesn't apply here.
// sendEmail() never throws — it swallows its own errors and returns { ok, error }
// instead, so a flaky or unconfigured email provider can never take down account
// activation or sign-in. Those are the real product; email is a nice-to-have on top.

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.MAIL_FROM_EMAIL || "hello@vibesafebuilder.com";
const FROM_NAME = process.env.MAIL_FROM_NAME || "VibeSafe Builder";

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY) {
    console.warn("RESEND_API_KEY not set — skipping email:", subject, "to", to);
    return { ok: false, error: "not_configured" };
  }
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        to: [to],
        subject,
        html,
      }),
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      console.error("Resend send failed:", r.status, body.message || body);
      return { ok: false, error: `resend_${r.status}` };
    }
    return { ok: true };
  } catch (err) {
    console.error("Resend send error:", err);
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
  return `<a href="${url}" style="display:inline-block;background:linear-gradient(135deg,#8b5cf6,#6d4aec);color:#fff;font-weight:700;font-size:14px;text-decoration:none;padding:12px 24px;border-radius:10px;margin-top:8px;">${label}</a>`;
}

// A neutral button for actions that are informational, not a positive CTA
// (e.g. "update your payment method" — green/violet gradient reads as good news,
// which is the wrong tone next to "your card was declined").
function buttonNeutral(url, label) {
  return `<a href="${url}" style="display:inline-block;background:#1d242c;border:1px solid #2a333d;color:#eef3f7;font-weight:700;font-size:14px;text-decoration:none;padding:12px 24px;border-radius:10px;margin-top:8px;">${label}</a>`;
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

function proActivationEmailHtml({ name, setPasswordUrl, reactivated = false }) {
  const greeting = name ? `Hey ${escapeHtml(name)},` : "Hey there,";
  const action = setPasswordUrl
    ? `<p style="color:#8d9aa8;font-size:14px;line-height:1.6;margin:0 0 20px;">One last step — set a password so you can log back in any time:</p>${button(setPasswordUrl, "Set your password")}`
    : button("https://vibesafebuilder.com/app", "Open the builder");
  const headline = reactivated ? "You're back on the Pro plan &#127881;" : "You're on the Pro plan &#127881;";
  const body = reactivated
    ? "Your payment went through and Managed access is active again — no API key needed, $10/mo of build budget included."
    : "Your payment went through and your account is now on the Managed plan — no API key needed, $10/mo of build budget included.";
  return shell(`
    <h1 style="color:#eef3f7;font-size:20px;margin:0 0 12px;">${headline}</h1>
    <p style="color:#eef3f7;font-size:14px;line-height:1.6;margin:0 0 16px;">${greeting}</p>
    <p style="color:#8d9aa8;font-size:14px;line-height:1.6;margin:0 0 16px;">${body}</p>
    ${action}
  `);
}

// Fires when Stripe reports the subscription as fully ended (customer.subscription.deleted)
// — not on a payment failure, which gets its own email and its own chance to fix the card
// before it comes to this.
function subscriptionCanceledEmailHtml({ name }) {
  const greeting = name ? `Hey ${escapeHtml(name)},` : "Hey there,";
  return shell(`
    <h1 style="color:#eef3f7;font-size:20px;margin:0 0 12px;">Your Managed plan has ended</h1>
    <p style="color:#eef3f7;font-size:14px;line-height:1.6;margin:0 0 16px;">${greeting}</p>
    <p style="color:#8d9aa8;font-size:14px;line-height:1.6;margin:0 0 16px;">
      Your VibeSafe Builder subscription is no longer active, so the $10/mo managed build budget has stopped.
      Nothing you've built is affected — your projects, versions and published apps are all still there.
    </p>
    <p style="color:#8d9aa8;font-size:14px;line-height:1.6;margin:0 0 20px;">
      You can keep building right away with your own Anthropic API key (Settings → Anthropic API key), or resubscribe any time.
    </p>
    ${button("https://vibesafebuilder.com/app", "Open the builder")}
  `);
}

// Fires on the FIRST failed payment attempt only (see shouldSendPaymentFailedEmail in
// lib/emailDecisions.js) — Stripe's own retries handle the rest, this is just the
// heads-up while there's still time to fix it before access actually lapses.
function paymentFailedEmailHtml({ name }) {
  const greeting = name ? `Hey ${escapeHtml(name)},` : "Hey there,";
  return shell(`
    <h1 style="color:#e06459;font-size:20px;margin:0 0 12px;">We couldn't process your payment</h1>
    <p style="color:#eef3f7;font-size:14px;line-height:1.6;margin:0 0 16px;">${greeting}</p>
    <p style="color:#8d9aa8;font-size:14px;line-height:1.6;margin:0 0 16px;">
      The card on file for your VibeSafe Builder Managed plan was declined. Stripe will automatically retry over
      the next couple of weeks — if it keeps failing, your Managed access will end and this reverts to the free plan.
    </p>
    <p style="color:#8d9aa8;font-size:14px;line-height:1.6;margin:0 0 20px;">
      To avoid any interruption, update your card directly with Stripe using the link in your original receipt email,
      or reply to this email and we'll help.
    </p>
    ${buttonNeutral("mailto:hello@vibesafebuilder.com", "Get help")}
  `);
}

// Routed through Resend (not Supabase's own auth email) for the same reason the
// new-account set-password link already is: consistent branding, and it works
// regardless of whether Supabase's own SMTP is configured correctly — which,
// unlike this Resend integration, has never been verified this session.
function passwordResetEmailHtml({ resetUrl }) {
  return shell(`
    <h1 style="color:#eef3f7;font-size:20px;margin:0 0 12px;">Reset your password</h1>
    <p style="color:#8d9aa8;font-size:14px;line-height:1.6;margin:0 0 16px;">
      Someone (hopefully you) asked to reset the password for this VibeSafe Builder account. This link is
      valid for a limited time and can only be used once.
    </p>
    ${button(resetUrl, "Reset your password")}
    <p style="color:#5f6b78;font-size:12.5px;line-height:1.6;margin:20px 0 0;">
      If you didn't request this, you can safely ignore this email — your password hasn't been changed.
    </p>
  `);
}

module.exports = {
  sendEmail,
  welcomeEmailHtml,
  proActivationEmailHtml,
  subscriptionCanceledEmailHtml,
  paymentFailedEmailHtml,
  passwordResetEmailHtml,
};
