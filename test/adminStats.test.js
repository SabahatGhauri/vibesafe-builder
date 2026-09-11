const { test } = require("node:test");
const assert = require("node:assert");
const {
  recordGenerationStat,
  summarizeDailyStats,
  isMissingTableError,
  fetchActivity,
  monthlyAmountCents,
  computeRevenue,
  fetchRevenue,
  loadAdminStats,
} = require("../lib/adminStats");

const NOW = new Date("2026-09-11T15:00:00Z");

// A thenable query builder: every chain method returns itself, awaiting it yields `result`.
function chain(result) {
  const c = {};
  for (const m of ["select", "gte", "order", "limit", "eq", "in"]) c[m] = () => c;
  c.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return c;
}

async function* iterate(items) {
  for (const item of items) yield item;
}

const price = (unit_amount, interval = "month", interval_count = 1, currency = "usd") => ({
  unit_amount, currency, recurring: { interval, interval_count },
});
const subscription = (status, items, extra = {}) => ({
  status, currency: "usd", items: { data: items }, ...extra,
});

/* ---------------- recordGenerationStat ---------------- */

test("records one aggregate increment with no identifying fields", async () => {
  const calls = [];
  const client = { rpc: async (name, args) => { calls.push({ name, args }); return { error: null }; } };
  await recordGenerationStat(client, { mode: "byok", cost: 0.12, succeeded: true });
  assert.deepEqual(calls, [{ name: "record_generation_stat", args: { p_mode: "byok", p_cost: 0.12, p_succeeded: true } }]);
});

test("a stats failure never throws into the generation", async () => {
  const client = { rpc: async () => { throw new Error("db down"); } };
  await assert.doesNotReject(recordGenerationStat(client, { mode: "managed", cost: 0.1, succeeded: false }));
  const errClient = { rpc: async () => ({ error: { message: "nope" } }) };
  await assert.doesNotReject(recordGenerationStat(errClient, { mode: "managed", cost: 0.1, succeeded: false }));
});

test("unknown modes, missing clients and bad costs are handled", async () => {
  const calls = [];
  const client = { rpc: async (name, args) => { calls.push(args); return { error: null }; } };
  await recordGenerationStat(client, { mode: "admin", cost: 1, succeeded: true });
  await recordGenerationStat(null, { mode: "byok", cost: 1, succeeded: true });
  await recordGenerationStat(client, { mode: "byok", cost: NaN, succeeded: false });
  assert.equal(calls.length, 1, "only the valid-mode call reaches the database");
  assert.equal(calls[0].p_cost, 0, "a NaN cost is recorded as 0, not NaN");
});

/* ---------------- activity ---------------- */

test("daily series is gap-free and ends today", () => {
  const s = summarizeDailyStats([], { days: 30, now: NOW });
  assert.equal(s.series.length, 30);
  assert.equal(s.series[29].day, "2026-09-11");
  assert.equal(s.series[0].day, "2026-08-13");
  assert.equal(s.activeDays, 0);
});

test("totals split by mode; out-of-window and unknown-mode rows are ignored", () => {
  const s = summarizeDailyStats(
    [
      { day: "2026-09-11", mode: "byok", builds: 3, failures: 1, cost: "0.40" },
      { day: "2026-09-10", mode: "managed", builds: 2, failures: 0, cost: 0.2 },
      { day: "2026-09-10", mode: "byok", builds: 1, failures: 0, cost: 0.1 },
      { day: "2026-01-01", mode: "byok", builds: 99, failures: 0, cost: 9 },
      { day: "2026-09-11", mode: "hacker", builds: 50, failures: 0, cost: 5 },
    ],
    { days: 30, now: NOW }
  );
  assert.deepEqual(s.totals.byok, { builds: 4, failures: 1, cost: 0.5 });
  assert.deepEqual(s.totals.managed, { builds: 2, failures: 0, cost: 0.2 });
  assert.deepEqual(s.series[29], { day: "2026-09-11", byok: 3, managed: 0, failures: 1 });
  assert.equal(s.activeDays, 2);
});

test("missing-table errors are recognised in both Postgres and PostgREST forms", () => {
  assert.ok(isMissingTableError({ code: "42P01" }));
  assert.ok(isMissingTableError({ code: "PGRST205", message: "Could not find the table 'public.generation_stats'" }));
  assert.ok(!isMissingTableError({ code: "42501", message: "permission denied" }));
  assert.ok(!isMissingTableError(null));
});

test("before migration 004 is applied, activity says so instead of failing", async () => {
  const client = { from: () => chain({ data: null, error: { code: "PGRST205", message: "Could not find the table" } }) };
  const a = await fetchActivity(client, { now: NOW });
  assert.equal(a.available, false);
  assert.match(a.reason, /004_generation_stats/);
});

/* ---------------- revenue ---------------- */

test("monthly normalisation across intervals and quantities", () => {
  assert.equal(monthlyAmountCents({ price: price(1500) }), 1500);
  assert.equal(monthlyAmountCents({ price: price(12000, "year") }), 1000);
  assert.equal(monthlyAmountCents({ price: price(4500, "month", 3) }), 1500);
  assert.equal(monthlyAmountCents({ price: price(1500), quantity: 2 }), 3000);
  assert.equal(Math.round(monthlyAmountCents({ price: price(1200, "week") })), 5200);
  assert.equal(monthlyAmountCents({ price: { unit_amount: 500 } }), 0, "a one-off price is not recurring revenue");
  assert.equal(monthlyAmountCents({}), 0);
});

test("only active and past_due count toward MRR; trialing and canceled are reported separately", () => {
  const since = NOW.getTime() / 1000;
  const r = computeRevenue(
    [
      subscription("active", [{ price: price(1500) }]),
      subscription("past_due", [{ price: price(1500) }]),
      subscription("trialing", [{ price: price(1500) }]),
      subscription("canceled", [{ price: price(1500) }], { canceled_at: since - 5 * 86400 }),
      subscription("canceled", [{ price: price(1500) }], { canceled_at: since - 90 * 86400 }),
      subscription("incomplete", [{ price: price(1500) }]),
    ],
    { now: NOW }
  );
  assert.deepEqual(r.mrr, [{ currency: "usd", cents: 3000 }]);
  assert.equal(r.paying, 2);
  assert.equal(r.pastDue, 1);
  assert.equal(r.trialing, 1);
  assert.equal(r.canceledRecently, 1, "only the cancellation inside 30 days counts");
});

test("currencies are never added together", () => {
  const r = computeRevenue([
    subscription("active", [{ price: price(1500) }]),
    { ...subscription("active", [{ price: price(1000, "month", 1, "eur") }]), currency: "eur" },
  ]);
  assert.deepEqual(r.mrr, [{ currency: "usd", cents: 1500 }, { currency: "eur", cents: 1000 }]);
});

test("revenue reports which Stripe account it is reading", async () => {
  const stripe = {
    subscriptions: { list: () => iterate([subscription("active", [{ price: price(1500) }])]) },
    invoices: { list: () => iterate([{ currency: "usd", amount_paid: 1500 }, { currency: "usd", amount_paid: 1500 }]) },
    accounts: { retrieve: async () => ({ id: "acct_123", settings: { dashboard: { display_name: "Vibesafe Builder" } } }) },
  };
  const r = await fetchRevenue(stripe, { now: NOW });
  assert.equal(r.available, true);
  assert.deepEqual(r.account, { id: "acct_123", name: "Vibesafe Builder" });
  assert.deepEqual(r.paidLast30, [{ currency: "usd", cents: 3000 }]);
  assert.equal(r.paying, 1);
});

test("revenue still loads when the key may not read account details", async () => {
  const stripe = {
    subscriptions: { list: () => iterate([]) },
    invoices: { list: () => iterate([]) },
    accounts: { retrieve: async () => { throw new Error("restricted key"); } },
  };
  const r = await fetchRevenue(stripe, { now: NOW });
  assert.equal(r.available, true);
  assert.equal(r.account, null);
});

test("no Stripe key means an explained empty section, not a crash", async () => {
  const r = await fetchRevenue({}, { configured: false });
  assert.equal(r.available, false);
  assert.match(r.reason, /STRIPE_SECRET_KEY/);
});

/* ---------------- independence ---------------- */

test("one section failing never blanks the others", async () => {
  const supabaseAdmin = { from: () => { throw new Error("database unreachable"); } };
  const stripe = {
    subscriptions: { list: () => iterate([subscription("active", [{ price: price(1500) }])]) },
    invoices: { list: () => iterate([]) },
    accounts: { retrieve: async () => ({ id: "acct_1" }) },
  };
  const s = await loadAdminStats({ supabaseAdmin, stripe, stripeConfigured: true, now: NOW });
  assert.equal(s.activity.available, false);
  assert.match(s.activity.error, /database unreachable/);
  assert.equal(s.apps.available, false);
  assert.equal(s.revenue.available, true, "Stripe data still shows while the database is down");
  assert.equal(s.revenue.paying, 1);
});
