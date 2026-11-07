const test = require("node:test");
const assert = require("node:assert/strict");
const { checkWriteAccess } = require("../lib/publishAuth");

// Minimal stand-in for the one query checkWriteAccess makes.
function db(rows, { fail = false } = {}) {
  return {
    from: () => ({
      select: () => ({
        eq: (_col, id) => ({
          maybeSingle: async () =>
            fail ? { data: null, error: { message: "down" } } : { data: rows[id] || null, error: null },
        }),
      }),
    }),
  };
}

const rows = {
  mine1234: { owner_id: "alice" },
  theirs12: { owner_id: "bob" },
  oldapp12: { owner_id: null },
};

test("a new publish with no id is allowed", async () => {
  assert.deepEqual(await checkWriteAccess(db(rows), { id: null, userId: "alice" }), { ok: true });
});

test("an id nobody has used yet is allowed", async () => {
  assert.equal((await checkWriteAccess(db(rows), { id: "fresh123", userId: "alice" })).ok, true);
});

test("the owner can republish their own app", async () => {
  assert.equal((await checkWriteAccess(db(rows), { id: "mine1234", userId: "alice" })).ok, true);
});

test("another account cannot overwrite someone else's app", async () => {
  const r = await checkWriteAccess(db(rows), { id: "theirs12", userId: "alice" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.equal(r.code, "not_owner");
});

test("an app from before ownership existed is locked for everyone", async () => {
  const r = await checkWriteAccess(db(rows), { id: "oldapp12", userId: "alice" });
  assert.equal(r.ok, false);
  assert.equal(r.code, "legacy_unowned");
});

test("if ownership can't be read, nothing is overwritten", async () => {
  const r = await checkWriteAccess(db(rows, { fail: true }), { id: "mine1234", userId: "alice" });
  assert.equal(r.ok, false);
  assert.equal(r.status, 503);
});
