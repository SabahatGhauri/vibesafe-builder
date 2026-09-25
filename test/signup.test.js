const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { registerSignupRoute, validateSignup, clientIp, GENERIC } = require("../lib/signup");

const SITE = "https://vibesafebuilder.com";

// A fixture that records everything the route decided to do, so the tests can
// assert on the side effects (who got mailed, what kind of link was generated)
// rather than only on the status code.
function fixture({ allowed = true, limitError = null, existingId = null, linkError = null, sendOk = true, linkUrl = "https://sb.test/verify?token=abc" } = {}) {
  const calls = { rpc: [], links: [], emails: [], lookups: [] };
  const supabaseAdmin = {
    rpc(name, args) {
      calls.rpc.push({ name, args });
      return Promise.resolve({ data: limitError ? null : allowed, error: limitError });
    },
    auth: {
      admin: {
        generateLink(opts) {
          calls.links.push(opts);
          if (linkError) return Promise.resolve({ data: null, error: linkError });
          return Promise.resolve({ data: { properties: { action_link: linkUrl }, user: { id: "u-1" } }, error: null });
        },
      },
    },
  };
  const app = express();
  app.use(express.json());
  registerSignupRoute(app, {
    supabaseAdmin,
    findUserIdByEmail: async (email) => { calls.lookups.push(email); return existingId; },
    sendEmail: async (msg) => { calls.emails.push(msg); return sendOk ? { ok: true } : { ok: false, error: "resend_500" }; },
    templates: {
      signupConfirmEmailHtml: ({ confirmUrl }) => `<a href="${confirmUrl}">confirm</a>`,
      existingAccountEmailHtml: ({ resetUrl }) => `<a href="${resetUrl}">reset</a>`,
    },
    siteUrl: SITE,
  });
  return { app, calls };
}

async function request(f, body, headers = {}) {
  const server = f.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const GOOD = { email: "new@example.com", password: "correct horse", name: "Sam" };

/* ---------------- validation ---------------- */

test("an address and a password of the right shape are required", () => {
  assert.equal(validateSignup({ email: "nope", password: "longenough" }).ok, false);
  assert.equal(validateSignup({ email: "a@b.co", password: "short" }).ok, false);
  assert.equal(validateSignup({ email: "", password: "longenough" }).ok, false);
  assert.equal(validateSignup({ email: "a@b.co", password: "x".repeat(200) }).ok, false);
  assert.equal(validateSignup({ email: "a@b.co", password: "longenough" }).ok, true);
});

test("a display name cannot carry newlines into the email we send", () => {
  const r = validateSignup({ email: "a@b.co", password: "longenough", name: "Sam\r\nBcc: x@y.com" });
  assert.ok(!r.name.includes("\n"));
  assert.ok(!r.name.includes("\r"));
});

test("an absurd display name is cut down rather than refused", () => {
  const r = validateSignup({ email: "a@b.co", password: "longenough", name: "n".repeat(500) });
  assert.equal(r.name.length, 80);
});

test("no name at all is fine", () => {
  assert.equal(validateSignup({ email: "a@b.co", password: "longenough" }).name, null);
});

test("the client address prefers x-real-ip and falls back to the first forwarded hop", () => {
  const req = (h) => ({ header: (k) => h[k.toLowerCase()] });
  assert.equal(clientIp(req({ "x-real-ip": "1.2.3.4" })), "1.2.3.4");
  assert.equal(clientIp(req({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" })), "9.9.9.9");
  assert.equal(clientIp(req({})), null);
});

/* ---------------- the happy path ---------------- */

test("a new address gets an account and a confirmation link we mailed ourselves", async () => {
  const f = fixture();
  const r = await request(f, GOOD);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, GENERIC);

  const link = f.calls.links[0];
  assert.equal(link.type, "signup", "creates the account rather than recovering one");
  assert.equal(link.password, GOOD.password, "the password is set now, so the link is the only step left");
  assert.equal(link.options.data.full_name, "Sam");
  assert.equal(link.options.redirectTo, `${SITE}/app`);

  assert.equal(f.calls.emails.length, 1);
  assert.match(f.calls.emails[0].subject, /confirm/i);
  assert.ok(f.calls.emails[0].html.includes("https://sb.test/verify?token=abc"));
  assert.equal(f.calls.emails[0].to, GOOD.email);
});

test("a retried send cannot produce two confirmation emails for one account", async () => {
  const f = fixture();
  await request(f, GOOD);
  assert.ok(f.calls.emails[0].idempotencyKey, "the send is keyed");
  const f2 = fixture();
  await request(f2, GOOD);
  assert.equal(f.calls.emails[0].idempotencyKey, f2.calls.emails[0].idempotencyKey, "and the key is stable across attempts");
});

/* ---------------- the part that must not leak ---------------- */

test("an address that already has an account gets the identical response", async () => {
  const fresh = await request(fixture(), GOOD);
  const taken = await request(fixture({ existingId: "u-existing" }), GOOD);
  assert.equal(fresh.status, taken.status);
  assert.deepEqual(fresh.data, taken.data, "the response cannot be used to check who has signed up");
});

test("but the owner of that inbox is told, and given a way back in", async () => {
  const f = fixture({ existingId: "u-existing" });
  await request(f, GOOD);
  assert.equal(f.calls.links[0].type, "recovery", "no second account is created");
  assert.match(f.calls.emails[0].subject, /already have/i);
  assert.ok(f.calls.emails[0].html.includes("https://sb.test/verify?token=abc"));
});

test("losing the race to a simultaneous signup answers like the existing-account case", async () => {
  // findUserIdByEmail said no, then generateLink found one anyway.
  const f = fixture({ linkError: { message: "User already registered" } });
  const r = await request(f, GOOD);
  assert.equal(r.status, 200);
  assert.deepEqual(r.data, GENERIC);
  assert.equal(f.calls.emails.length, 0);
});

/* ---------------- the throttle that replaces Supabase's ---------------- */

test("the throttle is consulted before anything is created or sent", async () => {
  const f = fixture({ allowed: false });
  const r = await request(f, GOOD);
  assert.equal(r.status, 429);
  assert.equal(f.calls.links.length, 0, "no account");
  assert.equal(f.calls.emails.length, 0, "no email");
  assert.equal(f.calls.rpc[0].name, "may_send_signup_email");
  assert.equal(f.calls.rpc[0].args.p_email, GOOD.email);
});

test("the address and the caller's IP are both handed to the throttle", async () => {
  const f = fixture();
  await request(f, GOOD, { "x-real-ip": "203.0.113.9" });
  assert.equal(f.calls.rpc[0].args.p_ip, "203.0.113.9");
});

test("a throttle that cannot be reached fails closed", async () => {
  // Otherwise a database blip turns this route back into an unlimited mailer.
  const f = fixture({ limitError: { message: "connection refused" } });
  const r = await request(f, GOOD);
  assert.equal(r.status, 503);
  assert.equal(f.calls.links.length, 0);
  assert.equal(f.calls.emails.length, 0);
});

/* ---------------- failures that must not be reported as success ---------------- */

test("an account created with no email sent says so instead of 'check your email'", async () => {
  const f = fixture({ sendOk: false });
  const r = await request(f, GOOD);
  assert.equal(r.status, 502);
  assert.match(r.data.error, /couldn't send/i);
  assert.match(r.data.error, /hello@vibesafebuilder\.com/, "there is a human way out");
});

test("a link that could not be generated is a plain failure, not a silent one", async () => {
  const f = fixture({ linkError: { message: "boom" } });
  const r = await request(f, GOOD);
  assert.equal(r.status, 503);
  assert.equal(f.calls.emails.length, 0);
});

test("an unconfigured server refuses rather than pretending", async () => {
  const app = express();
  app.use(express.json());
  registerSignupRoute(app, {
    supabaseAdmin: null,
    findUserIdByEmail: async () => null,
    sendEmail: async () => ({ ok: true }),
    templates: { signupConfirmEmailHtml: () => "", existingAccountEmailHtml: () => "" },
    siteUrl: SITE,
  });
  const r = await request({ app }, GOOD);
  assert.equal(r.status, 503);
});

test("a malformed request never reaches the throttle or the database", async () => {
  const f = fixture();
  const r = await request(f, { email: "nope", password: "x" });
  assert.equal(r.status, 400);
  assert.equal(f.calls.rpc.length, 0);
  assert.equal(f.calls.links.length, 0);
});
