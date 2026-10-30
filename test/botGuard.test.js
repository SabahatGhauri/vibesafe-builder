const { test } = require("node:test");
const assert = require("node:assert/strict");
const { botGuard, ruleFor } = require("../lib/botGuard");

const quiet = { warn() {}, error() {} };

// Runs the middleware against a fake request and reports what it did.
async function run(mw, { method = "POST", path = "/api/signup", body = {}, headers = {}, ip = "1.1.1.1" } = {}) {
  const req = { method, path, body, headers: { "x-real-ip": ip, ...headers }, socket: {} };
  const out = { passed: false, status: 200, json: null, headers: {} };
  const res = {
    status(code) { out.status = code; return this; },
    json(data) { out.json = data; return this; },
    setHeader(k, v) { out.headers[k] = v; },
  };
  await mw(req, res, () => { out.passed = true; });
  return out;
}

/* ---------------- crawlers and pages are never touched ---------------- */

const CRAWLER_UAS = [
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
  "Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)",
  "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
  "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
];

test("GET requests always pass, however many and from whom", async () => {
  const mw = botGuard({ log: quiet, turnstileSecret: "secret" });
  for (const ua of CRAWLER_UAS) {
    for (const path of ["/", "/pricing.html", "/blog/ai-doom-loop.html", "/sitemap.xml", "/robots.txt", "/p/abc123", "/api/signup"]) {
      for (let i = 0; i < 50; i++) {
        const r = await run(mw, { method: "GET", path, headers: { "user-agent": ua } });
        assert.equal(r.passed, true, `${ua} ${path}`);
      }
    }
  }
  assert.equal(mw.counter.size(), 0, "page loads are not even counted");
});

test("POSTs to routes that aren't listed pass untouched", async () => {
  const mw = botGuard({ log: quiet, turnstileSecret: "secret" });
  for (let i = 0; i < 100; i++) {
    assert.equal((await run(mw, { path: "/api/stripe-webhook" })).passed, true);
    assert.equal((await run(mw, { path: "/api/backend/xyz" })).passed, true);
  }
});

/* ---------------- rate limits ---------------- */

test("signup: the 6th attempt from one address in 15 minutes is refused", async () => {
  let t = 0;
  const mw = botGuard({ log: quiet, turnstileSecret: "", now: () => t });
  for (let i = 0; i < 5; i++) assert.equal((await run(mw)).passed, true, `attempt ${i + 1}`);
  const blocked = await run(mw);
  assert.equal(blocked.passed, false);
  assert.equal(blocked.status, 429);
  assert.equal(blocked.json.reason, "rate_limited");
  assert.equal(blocked.headers["Retry-After"], "900");

  // Someone else on another address is unaffected.
  assert.equal((await run(mw, { ip: "2.2.2.2" })).passed, true);
  // Other routes have their own counters.
  assert.equal((await run(mw, { path: "/api/generate" })).passed, true);

  // After the window the same address gets through again.
  t += 15 * 60 * 1000;
  assert.equal((await run(mw)).passed, true);
});

test("builds and Launch Check are rate limited too", async () => {
  const mw = botGuard({ log: quiet, turnstileSecret: "" });
  for (let i = 0; i < 40; i++) assert.equal((await run(mw, { path: "/api/generate" })).passed, true);
  assert.equal((await run(mw, { path: "/api/generate" })).status, 429);
  for (let i = 0; i < 10; i++) assert.equal((await run(mw, { path: "/api/launch-check" })).passed, true);
  assert.equal((await run(mw, { path: "/api/launch-check" })).status, 429);
});

test("public form submissions match by prefix", () => {
  assert.equal(ruleFor("POST", "/api/forms/public/abc123/submit").key, "POST /api/forms/public/*");
  assert.equal(ruleFor("GET", "/api/forms/public/abc123/submit"), null);
  assert.equal(ruleFor("POST", "/api/forms"), null, "the owner's own form routes are signed-in and unaffected");
});

/* ---------------- honeypot ---------------- */

test("a filled honeypot gets the normal-looking reply and goes no further", async () => {
  const mw = botGuard({ log: quiet, turnstileSecret: "" });
  const r = await run(mw, { body: { email: "bot@example.com", password: "x".repeat(10), website: "http://spam.example" } });
  assert.equal(r.passed, false);
  assert.equal(r.status, 200);
  assert.match(r.json.message, /Check your email/);

  const reset = await run(mw, { path: "/api/request-password-reset", body: { email: "a@b.co", website: "x" } });
  assert.equal(reset.passed, false);
  assert.match(reset.json.message, /reset link/);
});

test("an empty honeypot (a person) passes", async () => {
  const mw = botGuard({ log: quiet, turnstileSecret: "" });
  assert.equal((await run(mw, { body: { email: "a@b.co", website: "" } })).passed, true);
  assert.equal((await run(mw, { body: { email: "a@b.co" } })).passed, true, "older clients without the field still work");
});

/* ---------------- Turnstile ---------------- */

test("without a Turnstile secret the forms work exactly as before", async () => {
  let called = false;
  const mw = botGuard({ log: quiet, turnstileSecret: "", fetchImpl: async () => { called = true; } });
  assert.equal((await run(mw, { body: { email: "a@b.co" } })).passed, true);
  assert.equal(called, false);
});

function fakeTurnstile(success, seen = []) {
  return async (url, opts) => {
    seen.push({ url, body: Object.fromEntries(opts.body) });
    return { json: async () => ({ success }) };
  };
}

test("with a secret set: no token is refused without calling Cloudflare", async () => {
  const seen = [];
  const mw = botGuard({ log: quiet, turnstileSecret: "sk", fetchImpl: fakeTurnstile(true, seen) });
  const r = await run(mw, { body: { email: "a@b.co" } });
  assert.equal(r.status, 403);
  assert.equal(r.json.reason, "captcha_failed");
  assert.equal(seen.length, 0);
});

test("with a secret set: a valid token passes and is checked with the client's address", async () => {
  const seen = [];
  const mw = botGuard({ log: quiet, turnstileSecret: "sk", fetchImpl: fakeTurnstile(true, seen) });
  const r = await run(mw, { body: { email: "a@b.co", turnstileToken: "tok" }, ip: "9.9.9.9" });
  assert.equal(r.passed, true);
  assert.equal(seen[0].url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.deepEqual(seen[0].body, { secret: "sk", response: "tok", remoteip: "9.9.9.9" });
});

test("with a secret set: a rejected token is refused", async () => {
  const mw = botGuard({ log: quiet, turnstileSecret: "sk", fetchImpl: fakeTurnstile(false) });
  const r = await run(mw, { body: { turnstileToken: "forged" } });
  assert.equal(r.status, 403);
});

test("if Cloudflare can't be reached the form fails closed", async () => {
  const mw = botGuard({ log: quiet, turnstileSecret: "sk", fetchImpl: async () => { throw new Error("ECONNRESET"); } });
  const r = await run(mw, { body: { turnstileToken: "tok" } });
  assert.equal(r.status, 503);
  assert.equal(r.json.reason, "captcha_unavailable");
});

test("Turnstile is only asked for on sign-up and password reset, never on builds", async () => {
  const mw = botGuard({ log: quiet, turnstileSecret: "sk", fetchImpl: fakeTurnstile(false) });
  assert.equal((await run(mw, { path: "/api/generate" })).passed, true);
  assert.equal((await run(mw, { path: "/api/publish" })).passed, true);
});

/* ---------------- wired into the real app ---------------- */

test("the real app: crawlers get every public page, signup is limited, CSP allows the widget", async () => {
  for (const key of ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY", "STRIPE_SECRET_KEY", "TURNSTILE_SECRET_KEY", "TURNSTILE_SITE_KEY"]) delete process.env[key];
  const app = require("../lib/app");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const ua of [CRAWLER_UAS[0], CRAWLER_UAS[1], CRAWLER_UAS[2]]) {
      for (const path of ["/", "/pricing.html", "/robots.txt", "/sitemap.xml"]) {
        for (let i = 0; i < 15; i++) {
          const r = await fetch(base + path, { headers: { "user-agent": ua }, redirect: "manual" });
          assert.equal(r.status, 200, `${ua} ${path}`);
          await r.arrayBuffer();
        }
      }
    }

    const statuses = [];
    for (let i = 0; i < 6; i++) {
      const r = await fetch(base + "/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-real-ip": "203.0.113.7" },
        body: JSON.stringify({ email: "a@example.com", password: "long enough" }),
      });
      statuses.push(r.status);
      await r.arrayBuffer();
    }
    assert.equal(statuses[5], 429, `statuses: ${statuses}`);
    assert.ok(statuses.slice(0, 5).every((s) => s !== 429));

    const appPage = await fetch(base + "/app");
    const csp = appPage.headers.get("content-security-policy");
    await appPage.arrayBuffer();
    assert.match(csp, /script-src[^;]*https:\/\/challenges\.cloudflare\.com/);
    assert.match(csp, /frame-src 'self' data: blob: https:\/\/challenges\.cloudflare\.com/);
    assert.match(csp, /frame-ancestors 'self'/);

    const home = await fetch(base + "/");
    assert.match(home.headers.get("content-security-policy"), /frame-ancestors 'none'/, "site-wide CSP unchanged");
    await home.arrayBuffer();

    const cfg = await (await fetch(base + "/api/config")).json();
    assert.equal(cfg.turnstileSiteKey, null, "no widget until keys are configured");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
