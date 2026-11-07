const test = require("node:test");
const assert = require("node:assert/strict");
const { acquireBuildLock, releaseBuildLock, addUsage, maxTokensFor, LOCK_STALE_MS } = require("../lib/usageGuard");
const { isBlockedRequest } = require("../lib/launchCheck");

// In-memory generation_locks with the unique-key behaviour Postgres gives us.
function lockDb() {
  const locks = new Map();
  const table = {
    insert: async (row) => {
      if (locks.has(row.user_id)) return { error: { code: "23505", message: "duplicate key" } };
      locks.set(row.user_id, row.locked_at);
      return { error: null };
    },
    select: () => ({
      eq: (_c, id) => ({ maybeSingle: async () => ({ data: locks.has(id) ? { locked_at: locks.get(id) } : null }) }),
    }),
    update: (patch) => ({
      eq: (_c, id) => ({
        eq: (_c2, old) => ({
          select: async () => {
            if (locks.get(id) !== old) return { data: [] };
            locks.set(id, patch.locked_at);
            return { data: [{ user_id: id }] };
          },
        }),
      }),
    }),
    delete: () => ({ eq: async (_c, id) => (locks.delete(id), { error: null }) }),
  };
  return { from: () => table, locks };
}

test("only one platform-key build per account at a time", async () => {
  const db = lockDb();
  assert.equal(await acquireBuildLock(db, "u1"), true);
  assert.equal(await acquireBuildLock(db, "u1"), false, "a second parallel build is refused");
  assert.equal(await acquireBuildLock(db, "u2"), true, "other accounts are unaffected");
  await releaseBuildLock(db, "u1");
  assert.equal(await acquireBuildLock(db, "u1"), true, "free again once the first finishes");
});

test("a lock left behind by a crashed request expires", async () => {
  const db = lockDb();
  const t0 = Date.now();
  await acquireBuildLock(db, "u1", t0);
  assert.equal(await acquireBuildLock(db, "u1", t0 + 1000), false);
  assert.equal(await acquireBuildLock(db, "u1", t0 + LOCK_STALE_MS + 1), true);
});

test("before migration 012, builds are not blocked", async () => {
  const db = { from: () => ({ insert: async () => ({ error: { code: "42P01", message: 'relation "generation_locks" does not exist' } }) }) };
  assert.equal(await acquireBuildLock(db, "u1"), true);
});

test("an unknown lock error refuses the build rather than risk parallel spend", async () => {
  const db = { from: () => ({ insert: async () => ({ error: { code: "XX000", message: "boom" } }) }) };
  assert.equal(await acquireBuildLock(db, "u1"), false);
});

test("spend is added inside the database when add_usage exists", async () => {
  const calls = [];
  const db = { rpc: async (name, args) => (calls.push([name, args]), { error: null }) };
  await addUsage(db, { userId: "u1", period: "2026-11", amount: 0.42, succeeded: true });
  assert.deepEqual(calls, [["add_usage", { p_user: "u1", p_period: "2026-11", p_amount: 0.42, p_build: 1 }]]);
});

test("negative or junk cost is never recorded as a refund", async () => {
  const calls = [];
  const db = { rpc: async (name, args) => (calls.push(args), { error: null }) };
  await addUsage(db, { userId: "u1", period: "2026-11", amount: -5, succeeded: false });
  await addUsage(db, { userId: "u1", period: "2026-11", amount: NaN, succeeded: false });
  assert.equal(calls[0].p_amount, 0);
  assert.equal(calls[1].p_amount, 0);
});

test("max_tokens shrinks with the budget that's left", () => {
  // $25 per million output tokens: $10 left affords 400k, capped at the 64k ceiling.
  assert.equal(maxTokensFor({ remaining: 10, outputPerMTok: 25, ceiling: 64000 }), 64000);
  // $0.50 left affords 20k tokens.
  assert.equal(maxTokensFor({ remaining: 0.5, outputPerMTok: 25, ceiling: 64000 }), 20000);
  // Nearly nothing left still leaves room for a small answer.
  assert.equal(maxTokensFor({ remaining: 0.01, outputPerMTok: 25, ceiling: 64000 }), 4000);
});

test("Launch Check can't reach our own network or cloud metadata", () => {
  for (const url of [
    "http://169.254.169.254/latest/meta-data/",
    "https://169.254.169.254/",
    "https://10.0.0.5/admin",
    "https://192.168.1.1/",
    "https://localhost:5432/",
    "https://[::1]/",
    "file:///etc/passwd",
    "http://example.com/plain-http",
  ]) {
    assert.equal(isBlockedRequest(url), true, url);
  }
  for (const url of ["https://cdn.jsdelivr.net/npm/x", "https://fonts.gstatic.com/a.woff2", "data:image/png;base64,AA"]) {
    assert.equal(isBlockedRequest(url), false, url);
  }
});
