"use strict";

// Account signup, with the confirmation email sent by us rather than by Supabase.
//
// Why this exists at all. Supabase warned this project about a high auth-email
// bounce rate and threatened its sending privileges. Everything else we mail
// already goes out through Resend on a verified domain - password resets, the
// welcome email, a paying customer's set-password link - all of them using
// admin.generateLink(), which returns a link and deliberately sends nothing
// itself. Signup confirmation was the last flow still going through Supabase's
// own sender, so it was the only thing that warning could actually break. This
// closes that gap: now no auth email depends on Supabase's SMTP settings, and
// all four arrive looking the same.
//
// Two things the swap has to be careful about.
//
// The admin API has no rate limit. Supabase's public signup endpoint did, and
// we are no longer behind it, so may_send_signup_email() (migration 010)
// replaces it. Without that this route is an open relay pointed at any address
// a caller likes.
//
// And the response cannot reveal whether an address already has an account.
// Supabase's signUp() is careful about this and ours has to be too, or the form
// becomes a way to check who has signed up. Every outcome below - new account,
// existing account, nothing sent at all - returns the same body. The existing
// account gets a different EMAIL (there is no point confirming an account that
// is already confirmed), but the caller cannot see which one was sent.

const GENERIC = {
  message: "Check your email to confirm your account, then come back and log in.",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8; // matches the placeholder and the client-side check
const MAX_NAME = 80;

// Format problems are safe to report precisely: they are facts about what the
// caller typed, not about who else has an account.
function validateSignup({ email, password, name }) {
  const cleanEmail = String(email || "").trim();
  if (!cleanEmail || !EMAIL_RE.test(cleanEmail)) return { ok: false, error: "Enter a valid email." };
  if (cleanEmail.length > 254) return { ok: false, error: "Enter a valid email." };

  const pass = String(password || "");
  if (pass.length < MIN_PASSWORD) return { ok: false, error: `Your password needs at least ${MIN_PASSWORD} characters.` };
  if (pass.length > 72) return { ok: false, error: "That password is too long." };

  // A display name goes into an email we send, so it is length-capped and
  // stripped of the control characters that could break out of a header. The
  // templates escape it for HTML separately.
  const cleanName = String(name || "").replace(/[\r\n\t]/g, " ").trim().slice(0, MAX_NAME);

  return { ok: true, email: cleanEmail, password: pass, name: cleanName || null };
}

// Vercel sets both of these; x-real-ip is the single client address, while
// x-forwarded-for is a chain whose first hop is the client. Neither is
// trustworthy on its own - the per-IP limit is a speed bump for casual abuse,
// and the per-address limit is the one that actually protects a given inbox.
function clientIp(req) {
  const real = String(req.header("x-real-ip") || "").trim();
  if (real) return real;
  const fwd = String(req.header("x-forwarded-for") || "").split(",")[0].trim();
  return fwd || null;
}

function registerSignupRoute(app, { supabaseAdmin, findUserIdByEmail, sendEmail, templates, siteUrl }) {
  app.post("/api/signup", async (req, res) => {
    const check = validateSignup(req.body || {});
    if (!check.ok) return res.status(400).json({ error: check.error });
    const { email, password, name } = check;

    if (!supabaseAdmin) {
      return res.status(503).json({ error: "Sign-up isn't configured on this server." });
    }

    try {
      const { data: allowed, error: limitError } = await supabaseAdmin.rpc("may_send_signup_email", {
        p_email: email,
        p_ip: clientIp(req),
      });
      // A throttle that cannot be consulted fails closed. The alternative is
      // that a database blip turns this route back into an unlimited mailer.
      if (limitError) {
        console.error("Signup throttle check failed:", limitError.message);
        return res.status(503).json({ error: "Couldn't create your account just now. Try again shortly." });
      }
      if (allowed === false) {
        return res.status(429).json({ error: "Too many attempts for that address. Try again in an hour." });
      }

      // An address that already has an account gets told so by email, not by
      // the response. Sending a reset link rather than nothing means someone
      // who forgot they had signed up still has a way in from here.
      const existingId = await findUserIdByEmail(email);
      if (existingId) {
        const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
          type: "recovery",
          email,
          options: { redirectTo: `${siteUrl}/app` },
        });
        const resetUrl = linkData?.properties?.action_link;
        if (linkError || !resetUrl) {
          console.error("Could not generate a reset link for an existing signup attempt:", linkError?.message);
        } else {
          const sent = await sendEmail({
            to: email,
            subject: "You already have a VibeSafe Builder account",
            html: templates.existingAccountEmailHtml({ resetUrl }),
          });
          if (!sent.ok) console.error("Could not send existing-account email:", sent.error);
        }
        return res.json(GENERIC);
      }

      // type: "signup" creates the user in an unconfirmed state and hands back
      // the confirmation link without mailing it. The password is set here, so
      // the account is usable the moment the link is clicked - no separate
      // "now choose a password" step.
      const { data, error } = await supabaseAdmin.auth.admin.generateLink({
        type: "signup",
        email,
        password,
        options: {
          data: name ? { full_name: name } : undefined,
          redirectTo: `${siteUrl}/app`,
        },
      });

      // Losing the race against a simultaneous signup for the same address
      // lands here. It is the existing-account case arriving a moment late, so
      // it answers the same way rather than reporting a conflict.
      if (error && /already (been )?registered|already exists/i.test(error.message || "")) {
        return res.json(GENERIC);
      }

      const confirmUrl = data?.properties?.action_link;
      if (error || !confirmUrl) {
        console.error("Could not generate a signup confirmation link:", error?.message);
        return res.status(503).json({ error: "Couldn't create your account just now. Try again shortly." });
      }

      const sent = await sendEmail({
        to: email,
        subject: "Confirm your VibeSafe Builder account",
        html: templates.signupConfirmEmailHtml({ confirmUrl, name }),
        // Retrying a failed send must not produce a second account email for
        // the same person; the user id makes that stable across attempts.
        idempotencyKey: `signup-confirm-${data?.user?.id || email}`,
      });
      if (!sent.ok) {
        // The account now exists but its owner has no way to reach it, and
        // saying "check your email" would be a lie. This is the one case that
        // reports a real failure, because the recovery path is a human one.
        console.error("Signup confirmation email failed for a created account:", sent.error);
        return res.status(502).json({
          error: "Your account was created, but we couldn't send the confirmation email. Email hello@vibesafebuilder.com and we'll sort it out.",
        });
      }

      res.json(GENERIC);
    } catch (err) {
      console.error("Signup error:", err && err.message);
      res.status(503).json({ error: "Couldn't create your account just now. Try again shortly." });
    }
  });
}

module.exports = { registerSignupRoute, validateSignup, clientIp, GENERIC, MIN_PASSWORD };
