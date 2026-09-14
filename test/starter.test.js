const { test } = require("node:test");
const assert = require("node:assert");
const {
  STARTER_PRICING,
  monthPeriod,
  starterConfig,
  decideStarter,
  costFor,
  checkStarter,
  recordStarterUsage,
  starterUnavailableMessage,
} = require("../lib/starter");

const NOW = new Date("2026-09-14T10:00:00Z");
const cfg = (over = {}) => ({ enabled: true, builds: 1, perUserCap: 0.15, monthlyCap: 2, ...over });

/* ---------------- config ---------------- */

test("defaults: on, 1 build, $0.15 per account, $2 a month", () => {
  assert.deepEqual(starterConfig({}), { enabled: true, builds: 1, perUserCap: 0.15, monthlyCap: 2 });
});

test("limits are set from the environment, and junk values fall back to defaults", () => {
  assert.deepEqual(
    starterConfig({ STARTER_BUILDS: "3", STARTER_USER_CAP: "0.5", STARTER_MONTHLY_CAP: "10" }),
    { enabled: true, builds: 3, perUserCap: 0.5, monthlyCap: 10 }
  );
  const junk = starterConfig({ STARTER_BUILDS: "lots", STARTER_USER_CAP: "-1", STARTER_MONTHLY_CAP: "" });
  assert.deepEqual(junk, { enabled: true, builds: 1, perUserCap: 0.15, monthlyCap: 2 });
});

test("the kill switch turns the trial off", () => {
  assert.equal(starterConfig({ STARTER_BUILDS_ENABLED: "off" }).enabled, false);
  assert.equal(starterConfig({ STARTER_BUILDS_ENABLED: " OFF " }).enabled, false);
});

/* ---------------- decision ---------------- */

test("a new account gets its free build", () => {
  const d = decideStarter({ config: cfg(), usage: {}, monthSpent: 0 });
  assert.deepEqual(d, { available: true, reason: null, buildsLeft: 1, buildsTotal: 1 });
});

test("after one successful build the trial is used", () => {
  const d = decideStarter({ config: cfg(), usage: { builds: 1, spent: 0.04 }, monthSpent: 0.04 });
  assert.equal(d.available, false);
  assert.equal(d.reason, "used");
});

test("failed attempts that reach the per-account dollar cap end the trial even with no successful build", () => {
  const d = decideStarter({ config: cfg(), usage: { builds: 0, spent: 0.15 }, monthSpent: 0.15 });
  assert.equal(d.reason, "used", "retrying failures must not be free forever");
});

test("the monthly cap pauses the trial for everyone", () => {
  const d = decideStarter({ config: cfg(), usage: {}, monthSpent: 2 });
  assert.equal(d.available, false);
  assert.equal(d.reason, "paused");
  assert.equal(d.buildsLeft, 1, "the account still has its build for next month");
});

test("disabled, or zero builds configured, gives nothing away", () => {
  assert.equal(decideStarter({ config: cfg({ enabled: false }), usage: {}, monthSpent: 0 }).reason, "disabled");
  assert.equal(decideStarter({ config: cfg({ builds: 0 }), usage: {}, monthSpent: 0 }).reason, "disabled");
});

/* ---------------- cost ---------------- */

test("cost uses the free model's price, not the paid model's", () => {
  const c = costFor({ input_tokens: 1_000_000, output_tokens: 1_000_000 }, STARTER_PRICING);
  assert.equal(c, 12, "$2 input + $10 output per million");
  const cached = costFor({ input_tokens: 0, cache_read_input_tokens: 500_000, output_tokens: 0 }, STARTER_PRICING);
  assert.equal(cached, 1);
});

test("month periods are UTC and zero-padded", () => {
  assert.equal(monthPeriod(NOW), "starter-2026-09");
  assert.equal(monthPeriod(new Date("2026-12-31T23:59:59Z")), "starter-2026-12");
});

/* ---------------- database helpers ---------------- */

// In-memory managed_usage keyed by user_id + period, with the query shapes used.
function fakeDb(rows = []) {
  const table = rows.map((r) => ({ ...r }));
  const writes = [];
  return {
    table,
    writes,
    from: () => {
      const filters = {};
      const q = {
        select: () => q,
        eq: (col, val) => { filters[col] = val; return q; },
        maybeSingle: async () => ({
          data: table.find((r) => r.user_id === filters.user_id && r.period === filters.period) || null,
          error: null,
        }),
        upsert: async (row) => {
          writes.push(row);
          const i = table.findIndex((r) => r.user_id === row.user_id && r.period === row.period);
          if (i >= 0) table[i] = row; else table.push(row);
          return { error: null };
        },
        then: (resolve) =>
          resolve({ data: table.filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v)), error: null }),
      };
      return q;
    },
  };
}

test("recording writes both the lifetime row and this month's row", async () => {
  const db = fakeDb();
  await recordStarterUsage(db, "u1", 0.04, true, NOW);
  await recordStarterUsage(db, "u1", 0.02, false, NOW);
  const lifetime = db.table.find((r) => r.period === "starter");
  const month = db.table.find((r) => r.period === "starter-2026-09");
  assert.equal(lifetime.build_count, 1, "only the success uses up a build");
  assert.equal(Number(lifetime.dollars_spent.toFixed(2)), 0.06, "both attempts' cost is recorded");
  assert.equal(month.build_count, 1);
});

test("the monthly cap sums every account's spend this month, ignoring other periods", async () => {
  const db = fakeDb([
    { user_id: "a", period: "starter-2026-09", dollars_spent: 1.5, build_count: 30 },
    { user_id: "b", period: "starter-2026-09", dollars_spent: 0.6, build_count: 12 },
    { user_id: "c", period: "starter-2026-08", dollars_spent: 9, build_count: 99 },
    { user_id: "d", period: "2026-09", dollars_spent: 9, build_count: 99 },
  ]);
  const d = await checkStarter(db, "new-user", cfg(), NOW);
  assert.equal(d.reason, "paused", "$2.10 this month is over the $2 cap");
});

test("if usage can't be read, no free build is given away", async () => {
  const db = { from: () => { throw new Error("database down"); } };
  const d = await checkStarter(db, "u1", cfg(), NOW);
  assert.equal(d.available, false);
});

test("messages tell people plainly how to keep building", () => {
  assert.match(starterUnavailableMessage("used"), /own Anthropic API key.*upgrade to Pro.*Claude Opus 5/s);
  assert.match(starterUnavailableMessage("paused"), /this month's limit/);
  assert.equal(starterUnavailableMessage("disabled"), null);
});
