const { test } = require("node:test");
const assert = require("node:assert");
const { classifyActivation, shouldSendPaymentFailedEmail } = require("../lib/emailDecisions");

/* --- classifyActivation --- */

test("a brand-new Supabase account is always 'new', regardless of oldStatus", () => {
  assert.equal(classifyActivation({ isNewUser: true, oldStatus: undefined }), "new");
  assert.equal(classifyActivation({ isNewUser: true, oldStatus: "canceled" }), "new");
});

test("an existing account with no prior row (first-time purchase before signup) reactivates, not 'new'", () => {
  // isNewUser is about the SUPABASE account, not the subscriptions row - someone
  // could sign up for BYOK first, then pay later. They already have a login.
  assert.equal(classifyActivation({ isNewUser: false, oldStatus: undefined }), "reactivated");
});

test("an existing account whose subscription had lapsed reactivates", () => {
  assert.equal(classifyActivation({ isNewUser: false, oldStatus: "canceled" }), "reactivated");
});

test("THE BUG: already-active is skipped, so a duplicate webhook delivery does not re-send", () => {
  assert.equal(classifyActivation({ isNewUser: false, oldStatus: "active" }), "skip");
});

test("a new user is never skipped even if somehow marked active already", () => {
  // Should not be reachable in practice (a new Supabase user can't have a prior
  // active row), but isNewUser must win if it ever happens - never silently drop
  // the welcome-with-password-link email for a genuinely new account.
  assert.equal(classifyActivation({ isNewUser: true, oldStatus: "active" }), "new");
});

/* --- shouldSendPaymentFailedEmail --- */

test("the first failed attempt sends an email", () => {
  assert.equal(shouldSendPaymentFailedEmail({ attempt_count: 1 }), true);
});

test("retry attempts do not re-send - Stripe already tried and failed once", () => {
  assert.equal(shouldSendPaymentFailedEmail({ attempt_count: 2 }), false);
  assert.equal(shouldSendPaymentFailedEmail({ attempt_count: 5 }), false);
});

test("a missing or malformed attempt_count does not crash and does not send", () => {
  assert.equal(shouldSendPaymentFailedEmail({}), false);
  assert.equal(shouldSendPaymentFailedEmail({ attempt_count: null }), false);
  assert.equal(shouldSendPaymentFailedEmail(undefined), false);
});

test("a string attempt_count (raw webhook JSON) is still handled correctly", () => {
  assert.equal(shouldSendPaymentFailedEmail({ attempt_count: "1" }), true);
  assert.equal(shouldSendPaymentFailedEmail({ attempt_count: "2" }), false);
});
