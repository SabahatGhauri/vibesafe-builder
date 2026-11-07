const { test } = require("node:test");
const assert = require("node:assert/strict");
const billing = require("../lib/billing");

const PERIOD_END = 1767225600; // 2026-01-01T00:00:00Z

function sub(overrides = {}) {
  return {
    id: "sub_1",
    status: "active",
    created: 100,
    cancel_at_period_end: false,
    cancel_at: null,
    items: { data: [{ current_period_end: PERIOD_END }] },
    ...overrides,
  };
}

// A stand-in for the Stripe client that records what was asked of it.
function fakeStripe(subs) {
  const calls = { list: [], update: [] };
  return {
    calls,
    subscriptions: {
      list: async (args) => {
        calls.list.push(args);
        return { data: subs.filter((s) => s._customer === undefined || s._customer === args.customer) };
      },
      update: async (id, params) => {
        calls.update.push({ id, params });
        const s = subs.find((x) => x.id === id);
        Object.assign(s, params);
        if (params.cancel_at === "") s.cancel_at = null;
        return s;
      },
    },
  };
}

test("cancelling sets cancel_at_period_end and reports when access ends", async () => {
  const stripe = fakeStripe([sub()]);
  const result = await billing.cancelAtPeriodEnd(stripe, "cus_1");
  assert.deepEqual(stripe.calls.update, [{ id: "sub_1", params: { cancel_at_period_end: true } }]);
  assert.equal(stripe.calls.list[0].customer, "cus_1");
  assert.equal(result.cancelAtPeriodEnd, true);
  assert.equal(result.periodEnd, "2026-01-01T00:00:00.000Z");
});

test("cancelling twice does not call Stripe again", async () => {
  const stripe = fakeStripe([sub({ cancel_at_period_end: true })]);
  const result = await billing.cancelAtPeriodEnd(stripe, "cus_1");
  assert.equal(stripe.calls.update.length, 0);
  assert.equal(result.alreadyCanceling, true);
});

test("no live subscription means nothing to cancel", async () => {
  const stripe = fakeStripe([sub({ status: "canceled" })]);
  assert.deepEqual(await billing.cancelAtPeriodEnd(stripe, "cus_1"), { hasSubscription: false });
  assert.deepEqual(await billing.cancelAtPeriodEnd(stripe, null), { hasSubscription: false });
  assert.equal(stripe.calls.update.length, 0);
});

test("the newest live subscription is the one acted on", async () => {
  const stripe = fakeStripe([sub({ id: "sub_old", created: 1 }), sub({ id: "sub_new", created: 50 })]);
  await billing.cancelAtPeriodEnd(stripe, "cus_1");
  assert.equal(stripe.calls.update[0].id, "sub_new");
});

test("resuming undoes a pending cancellation", async () => {
  const stripe = fakeStripe([sub({ cancel_at_period_end: true })]);
  const result = await billing.resume(stripe, "cus_1");
  assert.deepEqual(stripe.calls.update, [{ id: "sub_1", params: { cancel_at_period_end: false } }]);
  assert.equal(result.cancelAtPeriodEnd, false);
});

test("resuming clears a dated cancellation set in the Stripe Dashboard", async () => {
  const stripe = fakeStripe([sub({ cancel_at: PERIOD_END })]);
  const result = await billing.resume(stripe, "cus_1");
  assert.deepEqual(stripe.calls.update, [{ id: "sub_1", params: { cancel_at: "" } }]);
  assert.equal(result.cancelAtPeriodEnd, false);
});

test("resuming a subscription that isn't cancelling changes nothing", async () => {
  const stripe = fakeStripe([sub()]);
  await billing.resume(stripe, "cus_1");
  assert.equal(stripe.calls.update.length, 0);
});

test("period end falls back to the older subscription-level field", () => {
  assert.equal(billing.periodEnd({ current_period_end: PERIOD_END }), "2026-01-01T00:00:00.000Z");
  assert.equal(billing.periodEnd({}), null);
});
