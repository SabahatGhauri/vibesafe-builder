const { test } = require("node:test");
const assert = require("node:assert");
const { validateAnthropicKey, looksLikeKey, interpret } = require("../lib/validateKey");

const GOOD = "sk-ant-api03-" + "A".repeat(80);
const res = (status) => async () => ({ status });

/* --- shape checks, before any network call --- */

test("an empty key is rejected without calling out", async () => {
  let called = false;
  const r = await validateAnthropicKey("", { fetchImpl: async () => { called = true; return { status: 200 }; } });
  assert.equal(r.valid, false);
  assert.equal(called, false, "no point asking Anthropic about an empty string");
});

test("a key not starting with sk-ant- is rejected with a useful reason", async () => {
  const r = await validateAnthropicKey("sk-proj-abc123def456ghi789jkl012mno345pqr", { fetchImpl: res(200) });
  assert.equal(r.valid, false);
  assert.match(r.message, /sk-ant-/);
});

test("a key containing whitespace is flagged as a copy-paste problem", async () => {
  const r = await validateAnthropicKey("sk-ant-api03-AAAA BBBB" + "C".repeat(40), { fetchImpl: res(200) });
  assert.equal(r.valid, false);
  assert.match(r.message, /space/i);
});

test("a truncated key is flagged as cut off", async () => {
  const r = await validateAnthropicKey("sk-ant-api03-short", { fetchImpl: res(200) });
  assert.equal(r.valid, false);
  assert.match(r.message, /too short|cut off/i);
});

test("surrounding whitespace is tolerated, not treated as an error", () => {
  assert.equal(looksLikeKey("  " + GOOD + "  ").ok, true);
});

/* --- network outcomes --- */

test("200 means the key works", async () => {
  const r = await validateAnthropicKey(GOOD, { fetchImpl: res(200) });
  assert.equal(r.valid, true);
  assert.equal(r.checked, true);
  assert.match(r.message, /works/i);
});

test("401 means the key is wrong, and says what to do", async () => {
  const r = await validateAnthropicKey(GOOD, { fetchImpl: res(401) });
  assert.equal(r.valid, false);
  assert.match(r.message, /rejected/i);
});

test("403 distinguishes a permissions problem from a wrong key", async () => {
  const r = await validateAnthropicKey(GOOD, { fetchImpl: res(403) });
  assert.equal(r.valid, false);
  assert.match(r.message, /permitted|permission/i);
});

test("rate limiting is NOT reported as an invalid key", async () => {
  const r = await validateAnthropicKey(GOOD, { fetchImpl: res(429) });
  assert.equal(r.valid, null, "429 says nothing about whether the key is good");
  assert.match(r.message, /rate-limit/i);
});

test("an Anthropic outage is NOT reported as an invalid key", async () => {
  for (const s of [500, 502, 503]) {
    const r = await validateAnthropicKey(GOOD, { fetchImpl: res(s) });
    assert.equal(r.valid, null, s + " must not condemn the key");
  }
});

test("a network failure is NOT reported as an invalid key", async () => {
  const r = await validateAnthropicKey(GOOD, { fetchImpl: async () => { throw new Error("ENOTFOUND"); } });
  assert.equal(r.valid, null, "telling someone their key is bad when we could not check sends them to regenerate a working key");
  assert.equal(r.checked, false);
  assert.match(r.message, /couldn't reach|try a build/i);
});

test("the key is sent as x-api-key with a version header, and never in the URL", async () => {
  let seenUrl, seenHeaders;
  await validateAnthropicKey(GOOD, { fetchImpl: async (u, o) => { seenUrl = u; seenHeaders = o.headers; return { status: 200 }; } });
  assert.equal(seenHeaders["x-api-key"], GOOD);
  assert.ok(seenHeaders["anthropic-version"], "Anthropic requires a version header");
  assert.ok(!seenUrl.includes(GOOD), "a key in a URL ends up in logs");
});

test("uses the free models endpoint, never a billable generation", async () => {
  let seenUrl;
  await validateAnthropicKey(GOOD, { fetchImpl: async (u) => { seenUrl = u; return { status: 200 }; } });
  assert.match(seenUrl, /\/v1\/models/);
  assert.ok(!/messages/.test(seenUrl), "checking a key must not cost the user tokens");
});

test("interpret() never claims validity it cannot prove", () => {
  assert.equal(interpret(200).valid, true);
  assert.equal(interpret(401).valid, false);
  assert.equal(interpret(429).valid, null);
  assert.equal(interpret(418).valid, null);
});
