const { test } = require("node:test");
const assert = require("node:assert");
const { canonicalHostRedirect } = require("../lib/canonicalHost");

const CANON = "vibesafebuilder.com";
const APPS = "apps.vibesafebuilder.com";

function run(mw, { host, path = "/", method = "GET", query = "" }) {
  const req = { hostname: host, path, method, originalUrl: path + query };
  let redirected = null, passed = false;
  const res = { redirect: (code, url) => { redirected = { code, url }; } };
  mw(req, res, () => { passed = true; });
  return { redirected, passed };
}

const prod = canonicalHostRedirect({ canonicalHost: CANON, appsHost: APPS, isProduction: true });
const preview = canonicalHostRedirect({ canonicalHost: CANON, appsHost: APPS, isProduction: false });

test("the real domain is never redirected", () => {
  for (const path of ["/", "/pricing.html", "/p/abc123", "/api/config"]) {
    assert.equal(run(prod, { host: CANON, path }).passed, true, path);
  }
});

test("apps host: marketing pages redirect to the real domain with a permanent 308", () => {
  const r = run(prod, { host: APPS, path: "/" });
  assert.deepEqual(r.redirected, { code: 308, url: "https://vibesafebuilder.com/" });
  const q = run(prod, { host: APPS, path: "/blog/ai-doom-loop.html", query: "?x=1" });
  assert.equal(q.redirected.url, "https://vibesafebuilder.com/blog/ai-doom-loop.html?x=1", "keeps path and query");
});

test("apps host: everything a published app needs still serves", () => {
  for (const path of ["/p/pviLpCqhYl", "/p/abc/sw.js", "/api/backend/records", "/favicon.ico", "/__lc-blank"]) {
    const r = run(prod, { host: APPS, path });
    assert.equal(r.passed, true, path + " must not redirect");
    assert.equal(r.redirected, null, path);
  }
});

test("apps host: app data writes are never redirected", () => {
  assert.equal(run(prod, { host: APPS, path: "/", method: "POST" }).passed, true);
});

test("production vercel.app alias redirects pages but keeps the API", () => {
  assert.equal(run(prod, { host: "vibesafe-builder.vercel.app", path: "/pricing.html" }).redirected.url,
    "https://vibesafebuilder.com/pricing.html");
  assert.equal(run(prod, { host: "vibesafe-builder.vercel.app", path: "/api/stripe-webhook", method: "GET" }).passed, true);
});

test("preview deployments stay browsable at their own URL", () => {
  assert.equal(run(preview, { host: "vibesafe-builder-abc123-team.vercel.app", path: "/" }).passed, true);
});

test("local development and unknown hosts are untouched", () => {
  assert.equal(run(prod, { host: "localhost", path: "/" }).passed, true);
  assert.equal(run(prod, { host: "", path: "/" }).passed, true);
});
