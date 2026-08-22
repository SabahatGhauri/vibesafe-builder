const { test } = require("node:test");
const assert = require("node:assert");
const { findUserIdByEmail, pickUserByEmail, PER_PAGE } = require("../lib/findUser");

const OPTS = { supabaseUrl: "https://x.supabase.co", serviceRoleKey: "svc" };
const user = (id, email) => ({ id, email });

/* A fetch stub that mimics the REAL endpoint: it ignores any email filter and
   just returns the requested page, which is the whole reason this bug existed. */
function stubPages(pages) {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    const page = Number(new URL(url).searchParams.get("page"));
    return { ok: true, json: async () => ({ users: pages[page - 1] || [] }) };
  };
  return { fetchImpl, seen };
}

test("THE BUG: does not return the first user when the address is absent", async () => {
  const { fetchImpl } = stubPages([[user("u_someone_else", "stranger@example.com")]]);
  const id = await findUserIdByEmail("payer@example.com", { ...OPTS, fetchImpl });
  assert.equal(id, null, "must never hand back an unrelated account");
});

test("finds the right user among many, not merely the first", async () => {
  const { fetchImpl } = stubPages([[
    user("u_a", "a@example.com"),
    user("u_b", "payer@example.com"),
    user("u_c", "c@example.com"),
  ]]);
  assert.equal(await findUserIdByEmail("payer@example.com", { ...OPTS, fetchImpl }), "u_b");
});

test("single-user project still resolves correctly", async () => {
  const { fetchImpl } = stubPages([[user("u_only", "payer@example.com")]]);
  assert.equal(await findUserIdByEmail("payer@example.com", { ...OPTS, fetchImpl }), "u_only");
});

test("matching is case- and whitespace-insensitive", async () => {
  const { fetchImpl } = stubPages([[user("u_a", "  Payer@Example.COM ")]]);
  assert.equal(await findUserIdByEmail("payer@example.com", { ...OPTS, fetchImpl }), "u_a");
});

test("a near-miss address is not treated as a match", async () => {
  const { fetchImpl } = stubPages([[user("u_a", "payer@example.com.au"), user("u_b", "xpayer@example.com")]]);
  assert.equal(await findUserIdByEmail("payer@example.com", { ...OPTS, fetchImpl }), null);
});

test("pages past the first when the user is further in", async () => {
  const full = Array.from({ length: PER_PAGE }, (_, i) => user("u" + i, `u${i}@example.com`));
  const { fetchImpl, seen } = stubPages([full, [user("u_target", "payer@example.com")]]);
  assert.equal(await findUserIdByEmail("payer@example.com", { ...OPTS, fetchImpl }), "u_target");
  assert.equal(seen.length, 2, "must have requested a second page");
  assert.match(seen[1], /page=2/);
});

test("stops at a short page instead of looping", async () => {
  const { fetchImpl, seen } = stubPages([[user("u_a", "a@example.com")]]);
  assert.equal(await findUserIdByEmail("payer@example.com", { ...OPTS, fetchImpl }), null);
  assert.equal(seen.length, 1);
});

test("an empty project returns null", async () => {
  const { fetchImpl } = stubPages([[]]);
  assert.equal(await findUserIdByEmail("payer@example.com", { ...OPTS, fetchImpl }), null);
});

test("an API failure returns null rather than a wrong id", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.equal(await findUserIdByEmail("payer@example.com", { ...OPTS, fetchImpl }), null);
});

test("a bare-array response body is handled too", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => [user("u_a", "payer@example.com")] });
  assert.equal(await findUserIdByEmail("payer@example.com", { ...OPTS, fetchImpl }), "u_a");
});

test("blank or missing email never matches anyone", async () => {
  const { fetchImpl } = stubPages([[user("u_a", "a@example.com"), user("u_blank", "")]]);
  for (const bad of ["", "   ", null, undefined]) {
    assert.equal(await findUserIdByEmail(bad, { ...OPTS, fetchImpl }), null);
  }
});

test("a user record with no email cannot be matched by a blank lookup", () => {
  assert.equal(pickUserByEmail([{ id: "u_x" }], ""), null);
  assert.equal(pickUserByEmail([{ id: "u_x", email: null }], "a@b.com"), null);
});

test("missing config returns null instead of calling out", async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({ users: [] }) }; };
  assert.equal(await findUserIdByEmail("a@b.com", { supabaseUrl: null, serviceRoleKey: "k", fetchImpl }), null);
  assert.equal(called, false);
});

test("never sends an email query param, which the API would silently ignore", async () => {
  const { fetchImpl, seen } = stubPages([[user("u_a", "payer@example.com")]]);
  await findUserIdByEmail("payer@example.com", { ...OPTS, fetchImpl });
  assert.ok(!seen[0].includes("email="), "relying on a nonexistent filter is the bug being fixed");
  assert.match(seen[0], /per_page=/);
});
