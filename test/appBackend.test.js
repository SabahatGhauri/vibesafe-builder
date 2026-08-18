// Offline unit tests — no database, no secrets, no network. Run with:
//   node --test test/
// These cover the pure logic that used to only be reachable through a live
// production round-trip: token signing/verification, password hashing, and
// publish-time HTML injection. Anything needing a real database belongs in an
// integration test against a dedicated test Supabase project, never production.

const { test } = require("node:test");
const assert = require("node:assert");

// Deterministic secret so tests never depend on deployment config.
process.env.APP_BACKEND_TOKEN_SECRET = "test-secret-not-used-anywhere-real";

const { signToken, verifyToken, hashPassword, verifyPassword, injectBackendConfig } = require("../lib/appBackend");

/* ---------------- tokens ---------------- */

test("a token verifies for the app it was minted for", () => {
  const t = signToken({ userId: "user-1", appId: "app-a" });
  assert.deepStrictEqual(verifyToken(t, "app-a"), { userId: "user-1" });
});

test("a token minted for one app does NOT verify against another", () => {
  const t = signToken({ userId: "user-1", appId: "app-a" });
  assert.strictEqual(verifyToken(t, "app-b"), null);
});

test("a tampered payload is rejected", () => {
  const t = signToken({ userId: "user-1", appId: "app-a" });
  const [, sig] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ sub: "attacker", appId: "app-a", exp: Date.now() + 10000 })).toString(
    "base64url"
  );
  assert.strictEqual(verifyToken(forged + "." + sig, "app-a"), null);
});

test("a tampered signature is rejected", () => {
  const t = signToken({ userId: "user-1", appId: "app-a" });
  const [payload] = t.split(".");
  assert.strictEqual(verifyToken(payload + ".deadbeef", "app-a"), null);
});

test("an expired token is rejected", () => {
  const crypto = require("crypto");
  const payload = Buffer.from(JSON.stringify({ sub: "u", appId: "app-a", iat: 0, exp: Date.now() - 1 })).toString(
    "base64url"
  );
  const sig = crypto
    .createHmac("sha256", require("crypto").createHash("sha256").update("x").digest())
    .update(payload)
    .digest("base64url");
  assert.strictEqual(verifyToken(payload + "." + sig, "app-a"), null);
});

test("malformed tokens are rejected without throwing", () => {
  for (const bad of [null, undefined, "", "nodot", "a.b.c.d", 12345, {}]) {
    assert.strictEqual(verifyToken(bad, "app-a"), null);
  }
});

/* ---------------- passwords ---------------- */

test("a correct password verifies", () => {
  const { salt, hash } = hashPassword("correct horse battery");
  assert.strictEqual(verifyPassword("correct horse battery", salt, hash), true);
});

test("a wrong password does not verify", () => {
  const { salt, hash } = hashPassword("correct horse battery");
  assert.strictEqual(verifyPassword("wrong password here", salt, hash), false);
});

test("the same password hashes differently each time (unique salt)", () => {
  const a = hashPassword("same-password");
  const b = hashPassword("same-password");
  assert.notStrictEqual(a.hash, b.hash);
  assert.notStrictEqual(a.salt, b.salt);
});

test("verifyPassword returns false rather than throwing on garbage input", () => {
  assert.strictEqual(verifyPassword("x", "not-base64!!", "also-garbage!!"), false);
});

/* ---------------- publish-time injection ---------------- */

test("backend config is injected into <head>", () => {
  const out = injectBackendConfig("<html><head><title>t</title></head><body></body></html>", {
    appId: "abc",
    appKey: "key123",
  });
  assert.match(out, /window\.VIBESAFE_APP_ID="abc"/);
  assert.match(out, /window\.VIBESAFE_APP_KEY="key123"/);
  assert.match(out, /window\.VIBESAFE_BACKEND_URL="\/api\/backend"/);
});

test("a key containing quotes cannot break out of the script tag", () => {
  const nasty = 'a";alert(1);var x="';
  const out = injectBackendConfig("<html><head></head></html>", { appId: "id", appKey: nasty });
  // JSON.stringify must have escaped the quotes — no bare alert(1) statement.
  assert.ok(!out.includes('";alert(1);var x="'));
  assert.ok(out.includes(JSON.stringify(nasty)));
});

test("html with no <head> still gets the config prepended", () => {
  const out = injectBackendConfig("<div>bare</div>", { appId: "id", appKey: "k" });
  assert.match(out, /^<script>window\.VIBESAFE_APP_ID/);
});

test("injection preserves the original document body", () => {
  const out = injectBackendConfig("<html><head></head><body><p>keep me</p></body></html>", {
    appId: "id",
    appKey: "k",
  });
  assert.ok(out.includes("<p>keep me</p>"));
});
