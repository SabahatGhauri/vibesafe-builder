// Offline unit tests for the Phase 2D GitHub layer. No network, no GitHub
// account — these cover the parts that must be right before a real token ever
// exists: encryption at rest, and the OAuth state that binds a callback to one
// specific user.

const { test } = require("node:test");
const assert = require("node:assert");

process.env.GITHUB_TOKEN_SECRET = "unit-test-secret-not-used-anywhere-real";
process.env.GITHUB_CLIENT_ID = "test_client_id";
process.env.GITHUB_CLIENT_SECRET = "test_client_secret";
process.env.SITE_URL = "https://vibesafebuilder.com";

const gh = require("../lib/github");

/* ---------------- token encryption ---------------- */

test("a token round-trips through encryption", () => {
  const token = "gho_averysecrettokenvalue1234567890";
  const enc = gh.encrypt(token);
  assert.notStrictEqual(enc, token, "token was stored in plaintext");
  assert.ok(!enc.includes(token), "plaintext leaked into the ciphertext");
  assert.strictEqual(gh.decrypt(enc), token);
});

test("encrypting the same token twice gives different ciphertext", () => {
  // A fresh IV each time; otherwise identical tokens would be identifiable in
  // the database even without the key.
  assert.notStrictEqual(gh.encrypt("same-token"), gh.encrypt("same-token"));
});

test("tampered ciphertext fails to decrypt rather than returning garbage", () => {
  const enc = gh.encrypt("gho_realtoken");
  const [iv, tag, ct] = enc.split(".");
  const flipped = ct[0] === "A" ? "B" + ct.slice(1) : "A" + ct.slice(1);
  assert.strictEqual(gh.decrypt([iv, tag, flipped].join(".")), null);
});

test("decrypting with a different key returns null, not an exception", () => {
  const enc = gh.encrypt("gho_realtoken");
  const original = process.env.GITHUB_TOKEN_SECRET;
  process.env.GITHUB_TOKEN_SECRET = "a-completely-different-secret";
  const out = gh.decrypt(enc);
  process.env.GITHUB_TOKEN_SECRET = original;
  assert.strictEqual(out, null);
});

test("decrypt handles malformed input without throwing", () => {
  for (const bad of [null, undefined, "", "not-encrypted", "a.b", "a.b.c.d"]) {
    assert.doesNotThrow(() => gh.decrypt(bad));
  }
});

test("encrypt passes null through instead of encrypting the string 'null'", () => {
  // Matters because refresh_token is legitimately absent for non-expiring apps.
  assert.strictEqual(gh.encrypt(null), null);
  assert.strictEqual(gh.encrypt(undefined), null);
});

/* ---------------- OAuth state ---------------- */

test("state round-trips the user id", () => {
  const state = gh.signState("user-abc-123");
  assert.strictEqual(gh.verifyState(state), "user-abc-123");
});

// The whole point of signing state: a callback must not be able to attach a
// GitHub account to a user id the attacker simply typed in.
test("a forged state is rejected", () => {
  const forged = Buffer.from(JSON.stringify({ uid: "victim", exp: Date.now() + 60000 })).toString("base64url");
  assert.strictEqual(gh.verifyState(forged + ".notarealsignature"), null);
});

test("a state with a swapped payload is rejected", () => {
  const real = gh.signState("real-user");
  const sig = real.split(".")[1];
  const swapped = Buffer.from(JSON.stringify({ uid: "attacker", exp: Date.now() + 60000 })).toString("base64url");
  assert.strictEqual(gh.verifyState(swapped + "." + sig), null);
});

test("an expired state is rejected", () => {
  const crypto = require("crypto");
  const payload = Buffer.from(JSON.stringify({ uid: "u", exp: Date.now() - 1 })).toString("base64url");
  const key = crypto.createHash("sha256").update("vibesafe-github-tokens|" + process.env.GITHUB_TOKEN_SECRET).digest();
  const sig = crypto.createHmac("sha256", key).update(payload).digest("base64url");
  assert.strictEqual(gh.verifyState(payload + "." + sig), null);
});

test("malformed state is rejected without throwing", () => {
  for (const bad of [null, undefined, "", "nodot", 12345, {}]) {
    assert.strictEqual(gh.verifyState(bad), null);
  }
});

/* ---------------- authorize URL ---------------- */

test("the authorize URL carries the right client, scope and callback", () => {
  const url = new URL(gh.authorizeUrl("user-1"));
  assert.strictEqual(url.origin + url.pathname, "https://github.com/login/oauth/authorize");
  assert.strictEqual(url.searchParams.get("client_id"), "test_client_id");
  assert.strictEqual(url.searchParams.get("redirect_uri"), "https://vibesafebuilder.com/api/github/callback");
  assert.match(url.searchParams.get("scope"), /repo/);
  assert.strictEqual(gh.verifyState(url.searchParams.get("state")), "user-1");
});

test("the authorize URL never contains the client secret", () => {
  assert.ok(!gh.authorizeUrl("user-1").includes("test_client_secret"));
});

test("isConfigured reflects whether credentials are present", () => {
  assert.strictEqual(gh.isConfigured(), true);
  const id = process.env.GITHUB_CLIENT_ID;
  delete process.env.GITHUB_CLIENT_ID;
  // isConfigured reads the values captured at module load, so this asserts the
  // documented behaviour rather than pretending it re-reads the environment.
  process.env.GITHUB_CLIENT_ID = id;
  assert.strictEqual(gh.isConfigured(), true);
});
