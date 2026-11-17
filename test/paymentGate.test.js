const test = require("node:test");
const assert = require("node:assert");
const { shouldActivate } = require("../lib/paymentGate");

const ev = (type, object) => ({ type, data: { object } });

test("a finished checkout activates only once it is paid", () => {
  assert.equal(shouldActivate(ev("checkout.session.completed", { payment_status: "paid" })), true);
  assert.equal(shouldActivate(ev("checkout.session.completed", { payment_status: "unpaid" })), false);
  assert.equal(shouldActivate(ev("checkout.session.completed", {})), false);
});

test("a $0 checkout Stripe settled itself (coupon or trial) still activates", () => {
  assert.equal(shouldActivate(ev("checkout.session.completed", { payment_status: "no_payment_required" })), true);
});

test("a delayed payment activates when it actually succeeds", () => {
  assert.equal(shouldActivate(ev("checkout.session.async_payment_succeeded", { payment_status: "paid" })), true);
});

test("an incomplete subscription is not treated as paid", () => {
  assert.equal(shouldActivate(ev("customer.subscription.created", { status: "incomplete" })), false);
  assert.equal(shouldActivate(ev("customer.subscription.created", { status: "active" })), true);
  assert.equal(shouldActivate(ev("customer.subscription.created", { status: "trialing" })), true);
});

test("a paid invoice activates; unrelated events do not", () => {
  assert.equal(shouldActivate(ev("invoice.payment_succeeded", {})), true);
  assert.equal(shouldActivate(ev("invoice.payment_failed", {})), false);
  assert.equal(shouldActivate(null), false);
});
