const { test } = require("node:test");
const assert = require("node:assert");
const { diffSubscriptions, fetchStripeSubscriptions, reconcile } = require("../lib/reconcile");

const sub = (customerId, status = "active", email = `${customerId}@example.com`) => ({
  id: "sub_" + customerId, status, customerId, email,
});
const row = (customerId, status = "active", user_id = "u_" + customerId) => ({
  user_id, stripe_customer_id: customerId, status,
});

test("the real incident: two paying in Stripe, one row in the table", () => {
  const d = diffSubscriptions([sub("cus_A"), sub("cus_B")], [row("cus_A")]);
  assert.equal(d.missing.length, 1);
  assert.equal(d.missing[0].customerId, "cus_B");
  assert.equal(d.okCount, undefined);
  assert.equal(d.ok.length, 1);
  assert.equal(d.stale.length, 0);
});

test("everything matching produces no work", () => {
  const d = diffSubscriptions([sub("cus_A"), sub("cus_B")], [row("cus_A"), row("cus_B")]);
  assert.equal(d.missing.length, 0);
  assert.equal(d.reactivate.length, 0);
  assert.equal(d.stale.length, 0);
  assert.equal(d.ok.length, 2);
});

test("a paying customer whose row says canceled is flagged for reactivation, not re-created", () => {
  const d = diffSubscriptions([sub("cus_A")], [row("cus_A", "canceled")]);
  assert.equal(d.missing.length, 0, "must not create a second account");
  assert.equal(d.reactivate.length, 1);
  assert.equal(d.reactivate[0].userId, "u_cus_A");
  assert.equal(d.reactivate[0].dbStatus, "canceled");
});

test("active for us but no longer paying is reported as stale", () => {
  const d = diffSubscriptions([], [row("cus_A")]);
  assert.equal(d.stale.length, 1);
  assert.equal(d.stale[0].customerId, "cus_A");
});

test("a canceled row with no Stripe subscription is not stale - both agree", () => {
  const d = diffSubscriptions([], [row("cus_A", "canceled")]);
  assert.equal(d.stale.length, 0);
});

test("trialing counts as entitled, matching the webhook handler", () => {
  const d = diffSubscriptions([sub("cus_T", "trialing")], []);
  assert.equal(d.missing.length, 1, "a trialing customer must not be left without access");
});

test("non-entitled Stripe statuses are ignored entirely", () => {
  for (const status of ["canceled", "incomplete", "past_due", "unpaid"]) {
    const d = diffSubscriptions([sub("cus_X", status)], []);
    assert.equal(d.missing.length, 0, status + " must not provision access");
  }
});

test("rows with no stripe_customer_id never match and never go stale", () => {
  const d = diffSubscriptions([sub("cus_A")], [{ user_id: "u_orphan", stripe_customer_id: null, status: "active" }]);
  assert.equal(d.missing.length, 1);
  assert.equal(d.stale.length, 0);
});

test("fetchStripeSubscriptions follows pagination instead of stopping at one page", async () => {
  const pages = {
    active: [
      { data: [{ id: "s1", status: "active", customer: { id: "cus_1", email: "a@x.com" } }], has_more: true },
      { data: [{ id: "s2", status: "active", customer: { id: "cus_2", email: "b@x.com" } }], has_more: false },
    ],
    trialing: [{ data: [], has_more: false }],
  };
  const calls = [];
  const stripe = {
    subscriptions: {
      list: async (opts) => {
        calls.push(opts);
        const q = pages[opts.status];
        return q.shift();
      },
    },
  };
  const out = await fetchStripeSubscriptions(stripe);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((s) => s.customerId), ["cus_1", "cus_2"]);
  const second = calls.find((c) => c.starting_after);
  assert.equal(second.starting_after, "s1", "second page must continue after the last id");
});

test("a customer expanded as a bare string id still yields a usable row", async () => {
  const stripe = {
    subscriptions: {
      list: async (o) => (o.status === "active"
        ? { data: [{ id: "s1", status: "active", customer: "cus_str" }], has_more: false }
        : { data: [], has_more: false }),
    },
  };
  const out = await fetchStripeSubscriptions(stripe);
  assert.equal(out[0].customerId, "cus_str");
  assert.equal(out[0].email, null);
});

/* --- reconcile() orchestration --- */

function fakeDeps({ stripeSubs, dbRows, activate }) {
  return {
    stripe: {
      subscriptions: {
        list: async (o) => ({
          data: stripeSubs.filter((s) => s.status === o.status).map((s) => ({
            id: s.id, status: s.status, customer: { id: s.customerId, email: s.email },
          })),
          has_more: false,
        }),
      },
    },
    supabaseAdmin: {
      from: () => ({
        select: async () => ({ data: dbRows, error: null }),
        update: () => ({ eq: async () => ({ error: null }) }),
      }),
    },
    activate,
  };
}

test("a dry run reports the gap and writes nothing", async () => {
  let activated = 0;
  const deps = fakeDeps({ stripeSubs: [sub("cus_A"), sub("cus_B")], dbRows: [row("cus_A")], activate: async () => { activated++; } });
  const out = await reconcile({ ...deps, apply: false });
  assert.equal(out.missing.length, 1);
  assert.equal(out.missing[0].customerId, "cus_B");
  assert.equal(activated, 0, "dry run must not provision anyone");
  assert.equal(out.applied, false);
});

test("applying provisions exactly the missing customer", async () => {
  const activated = [];
  const deps = fakeDeps({
    stripeSubs: [sub("cus_A"), sub("cus_B")],
    dbRows: [row("cus_A")],
    activate: async (email, customerId) => activated.push([email, customerId]),
  });
  const out = await reconcile({ ...deps, apply: true });
  assert.deepEqual(activated, [["cus_B@example.com", "cus_B"]]);
  assert.equal(out.actions[0].done, true);
});

test("one failing activation does not abort the rest", async () => {
  const deps = fakeDeps({
    stripeSubs: [sub("cus_A"), sub("cus_B")],
    dbRows: [],
    activate: async (email) => { if (email.startsWith("cus_A")) throw new Error("supabase down"); },
  });
  const out = await reconcile({ ...deps, apply: true });
  assert.equal(out.actions.length, 2);
  assert.equal(out.actions.find((a) => a.customerId === "cus_A").done, false);
  assert.equal(out.actions.find((a) => a.customerId === "cus_B").done, true);
});

test("a Stripe customer with no email is reported rather than provisioned blind", async () => {
  let called = false;
  const deps = fakeDeps({
    stripeSubs: [{ id: "s", status: "active", customerId: "cus_N", email: null }],
    dbRows: [],
    activate: async () => { called = true; },
  });
  const out = await reconcile({ ...deps, apply: true });
  assert.equal(called, false);
  assert.match(out.actions[0].error, /no email/);
});

test("stale rows are never auto-cancelled, only reported", async () => {
  const deps = fakeDeps({ stripeSubs: [], dbRows: [row("cus_GONE")], activate: async () => {} });
  const out = await reconcile({ ...deps, apply: true });
  assert.equal(out.stale.length, 1);
  assert.equal(out.actions.length, 0, "revoking access automatically is not safe");
});

/* --- account identification: which Stripe account did we actually query? --- */

test("the report names the Stripe account, so a clean result can be trusted", async () => {
  const deps = fakeDeps({ stripeSubs: [sub("cus_A")], dbRows: [row("cus_A")], activate: async () => {} });
  deps.stripe.accounts = { retrieve: async () => ({ id: "acct_LIVE", business_profile: { name: "SG DIGITAL VENTURES LLC" } }) };
  const out = await reconcile({ ...deps, apply: false });
  assert.equal(out.stripeAccount.id, "acct_LIVE");
  assert.equal(out.stripeAccount.name, "SG DIGITAL VENTURES LLC");
});

test("a failing account lookup degrades to null instead of breaking reconciliation", async () => {
  const deps = fakeDeps({ stripeSubs: [sub("cus_A")], dbRows: [], activate: async () => {} });
  deps.stripe.accounts = { retrieve: async () => { throw new Error("no permission"); } };
  const out = await reconcile({ ...deps, apply: false });
  assert.equal(out.stripeAccount, null);
  assert.equal(out.missing.length, 1, "the actual reconciliation must still run");
});

test("a Stripe client with no accounts API still reconciles", async () => {
  const deps = fakeDeps({ stripeSubs: [sub("cus_A")], dbRows: [], activate: async () => {} });
  const out = await reconcile({ ...deps, apply: false });
  assert.equal(out.stripeAccount, null);
  assert.equal(out.missing.length, 1);
});

test("status counts expose subscriptions that are present but not entitled", async () => {
  const deps = fakeDeps({
    stripeSubs: [sub("cus_A", "active"), sub("cus_B", "past_due"), sub("cus_C", "trialing")],
    dbRows: [row("cus_A")],
    activate: async () => {},
  });
  const out = await reconcile({ ...deps, apply: false });
  // past_due is fetched only if listed; the fake filters by requested status, so
  // only entitled ones arrive - which is exactly the behaviour being asserted.
  assert.equal(out.stripeStatusCounts.active, 1);
  assert.equal(out.stripeStatusCounts.trialing, 1);
  assert.equal(out.stripeStatusCounts.past_due, undefined, "past_due is never requested, so never counted as entitled");
});

test("ok entries list who matched, for cross-checking against the dashboard", async () => {
  const deps = fakeDeps({ stripeSubs: [sub("cus_A")], dbRows: [row("cus_A")], activate: async () => {} });
  const out = await reconcile({ ...deps, apply: false });
  assert.equal(out.ok.length, 1);
  assert.equal(out.ok[0].customerId, "cus_A");
});
