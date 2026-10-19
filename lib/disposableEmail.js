"use strict";

// Throwaway inbox domains we refuse at signup and for the free trial build.
//
// Why: on 2026-10-17 a script on one IP created accounts at maxxspace.com and
// 1secmail.com, aiming at the free trial build. Each confirmation it triggers
// goes to an inbox nobody keeps, which also drags down our sender reputation.
//
// This is a short list of the services that actually show up, not an attempt
// at completeness. The same list seeds public.blocked_email_domains
// (migration 011), which the Supabase "before user created" hook reads, so
// signups that skip /api/signup and go straight to Supabase are refused too.
// test/disposableEmail.test.js checks the two stay in sync.
const DISPOSABLE_DOMAINS = [
  "maxxspace.com",
  "1secmail.com", "1secmail.net", "1secmail.org", "esiix.com", "wwjmp.com", "xojxe.com", "yoggm.com",
  "itssvk.dev",
  "mailinator.com", "mailinator.net", "mailinator2.com",
  "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "guerrillamail.biz", "guerrillamailblock.com", "sharklasers.com", "grr.la", "pokemail.net", "spam4.me",
  "10minutemail.com", "10minutemail.net", "temp-mail.org", "temp-mail.io", "tempmail.com", "tempmail.net", "tempmailo.com", "tempmail.plus", "tempail.com", "tempr.email",
  "yopmail.com", "yopmail.net", "yopmail.fr",
  "trashmail.com", "trashmail.de", "throwawaymail.com", "getnada.com", "nada.email", "dispostable.com", "maildrop.cc", "mailnesia.com",
  "mohmal.com", "emailondeck.com", "fakeinbox.com", "mintemail.com", "mytemp.email", "moakt.com", "mail.tm", "mail.gw",
  "dropmail.me", "emltmp.com", "spymail.one", "minimail.gq", "burnermail.io", "inboxkitten.com", "tmail.ws", "tmpmail.org", "tmpmail.net",
  "byom.de", "discard.email", "mailcatch.com", "spambox.us", "33mail.com", "getairmail.com", "fexpost.com", "fextemp.com", "zeroe.ml",
  "cyclelove.cc", "dcctb.com", "wuuvo.com", "rteet.com", "ezztt.com", "vjuum.com", "laafd.com", "txcct.com",
];

const BLOCKED = new Set(DISPOSABLE_DOMAINS);

// Matches the domain itself and any subdomain of it (mailme.itssvk.dev).
function isDisposableEmail(email) {
  const at = String(email || "").lastIndexOf("@");
  if (at < 0) return false;
  const parts = String(email).slice(at + 1).trim().toLowerCase().replace(/\.$/, "").split(".");
  for (let i = 0; i < parts.length - 1; i++) {
    if (BLOCKED.has(parts.slice(i).join("."))) return true;
  }
  return false;
}

module.exports = { DISPOSABLE_DOMAINS, isDisposableEmail };
