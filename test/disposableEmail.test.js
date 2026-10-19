const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DISPOSABLE_DOMAINS, isDisposableEmail } = require("../lib/disposableEmail");
const { validateSignup } = require("../lib/signup");

test("the domains from the 2026-10-17 accounts are blocked", () => {
  for (const email of ["cfqdfmejpnhd@maxxspace.com", "vibesafe8hic21v2@1secmail.com", "1786091331758@mailme.itssvk.dev"]) {
    assert.equal(isDisposableEmail(email), true, email);
  }
});

test("subdomains and case are matched, lookalikes are not", () => {
  assert.equal(isDisposableEmail("A@Sub.Mailinator.COM"), true);
  assert.equal(isDisposableEmail("a@mailinator.com."), true);
  assert.equal(isDisposableEmail("a@notmailinator.com"), false);
  assert.equal(isDisposableEmail("someone@gmail.com"), false);
  assert.equal(isDisposableEmail("no-at-sign"), false);
  assert.equal(isDisposableEmail(""), false);
});

test("signup refuses a throwaway address with a clear message", () => {
  const r = validateSignup({ email: "x@maxxspace.com", password: "longenough" });
  assert.equal(r.ok, false);
  assert.match(r.error, /permanent email/);
  assert.equal(validateSignup({ email: "x@gmail.com", password: "longenough" }).ok, true);
});

test("the database seed in migration 011 matches the JS list", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../db/migrations/011_block_disposable_signups.sql"), "utf8");
  const seeded = [...sql.matchAll(/^\s*\('([^']+)'\)/gm)].map((m) => m[1]);
  assert.deepEqual([...seeded].sort(), [...DISPOSABLE_DOMAINS].sort());
  assert.equal(new Set(DISPOSABLE_DOMAINS).size, DISPOSABLE_DOMAINS.length, "no duplicates");
});
