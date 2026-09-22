const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { validateReport, injectReportBadge, takenDownPage, registerReportRoutes } = require("../lib/reports");

const APP = "abc123xyz";
const SITE = "https://vibesafebuilder.com";

test("a report needs a real app id and a known reason", () => {
  assert.deepEqual(validateReport({ appId: APP, reason: "illegal", details: "x", reporter: "a@b.com" }), {
    appId: APP, reason: "illegal", details: "x", reporter: "a@b.com",
  });
  assert.throws(() => validateReport({ appId: "../../etc", reason: "illegal" }), /app link/);
  assert.throws(() => validateReport({ appId: APP, reason: "because-i-said-so" }), /reason/);
  assert.throws(() => validateReport(null), /Invalid/);
});

test("an optional email is dropped when malformed, never rejected", () => {
  // The report matters more than being able to reply to it.
  for (const bad of ["not-an-email", "a@b.com\nbcc: x@y.com", "   "]) {
    assert.equal(validateReport({ appId: APP, reason: "spam", reporter: bad }).reporter, "");
  }
  assert.equal(validateReport({ appId: APP, reason: "spam" }).reporter, "");
});

test("long details are truncated rather than refused", () => {
  const r = validateReport({ appId: APP, reason: "other", details: "x".repeat(5000) });
  assert.equal(r.details.length, 2000);
});

test("the badge lands inside the app and points at the right report link", () => {
  const out = injectReportBadge("<html><body><h1>App</h1></body></html>", { appId: APP, siteUrl: SITE });
  assert.ok(out.includes(`${SITE}/report?app=${APP}`));
  assert.ok(out.indexOf("Report</a>") < out.indexOf("</body>"), "inside the document, not after it");
  assert.ok(out.includes("position:fixed"), "not something the app's own layout can bury");
});

test("a document with no body tag still gets the badge", () => {
  const out = injectReportBadge("<h1>fragment</h1>", { appId: APP, siteUrl: SITE });
  assert.ok(out.includes("Report</a>"));
});

test("a bogus app id never produces a badge", () => {
  const html = "<html><body></body></html>";
  for (const bad of ["", null, "short", "../../x", '"onload="alert(1)']) {
    assert.equal(injectReportBadge(html, { appId: bad, siteUrl: SITE }), html);
  }
});

test("the takedown page explains itself and stays out of search", () => {
  const page = takenDownPage("Sexual content involving a minor.");
  assert.ok(page.includes("taken offline"));
  assert.ok(page.includes('name="robots" content="noindex"'));
  assert.ok(page.includes("contact@vibesafebuilder.com"), "a mistaken takedown has a route back");
  assert.ok(takenDownPage(null).includes("removed after a review"), "works with no reason given");
});

test("a takedown reason is escaped, not rendered", () => {
  const page = takenDownPage('<img src=x onerror="alert(1)">');
  assert.ok(!page.includes("<img src=x"), "reason text can never inject markup");
  assert.ok(page.includes("&lt;img"));
});

/* ---- routes ---- */

function fixture({ admin = true, rpcError = null } = {}) {
  const calls = { reports: [], updates: [] };
  const db = {
    async rpc(fn, args) {
      calls.reports.push({ fn, args });
      return rpcError ? { data: null, error: { message: rpcError } } : { data: "new-id", error: null };
    },
    from() {
      let patch = null, filters = [];
      const q = {
        update(p) { patch = p; return q; },
        eq(k, v) { filters.push([k, v]); return q; },
        is() { return q; },
        select() { return q; },
        order() { return q; },
        limit() { return Promise.resolve({ data: [], error: null }); },
        maybeSingle() {
          calls.updates.push({ patch, filters });
          return Promise.resolve({ data: { id: APP, disabled_at: patch && patch.disabled_at }, error: null });
        },
        then(ok) { calls.updates.push({ patch, filters }); return Promise.resolve({ data: [], error: null }).then(ok); },
      };
      return q;
    },
  };
  const app = express();
  app.use(express.json());
  registerReportRoutes(app, {
    supabaseAdmin: db,
    sendEmail: async () => ({ ok: true }),
    siteUrl: SITE,
    requireAdmin: (req, res) => { if (admin) return true; res.status(401).json({ error: "Unauthorized" }); return false; },
  });
  return { app, calls };
}

async function request(f, path, { method = "GET", body } = {}) {
  const server = f.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("anyone can file a report — no account required", async () => {
  const f = fixture();
  const r = await request(f, "/api/report", { method: "POST", body: { appId: APP, reason: "malware", details: "phishes logins" } });
  assert.equal(r.status, 201);
  assert.equal(f.calls.reports[0].args.p_app, APP);
  assert.equal(f.calls.reports[0].args.p_reason, "malware");
});

test("flooding one app is rate-limited with a human answer", async () => {
  const f = fixture({ rpcError: "report_rate_limit" });
  const r = await request(f, "/api/report", { method: "POST", body: { appId: APP, reason: "spam" } });
  assert.equal(r.status, 429);
  assert.match(r.data.error, /already been reported/);
});

test("takedown and the report queue are owner-only", async () => {
  const f = fixture({ admin: false });
  assert.equal((await request(f, "/api/admin/reports")).status, 401);
  assert.equal((await request(f, `/api/admin/apps/${APP}/disable`, { method: "POST", body: {} })).status, 401);
});

test("disabling an app records when and why, and can be undone", async () => {
  const f = fixture();
  const off = await request(f, `/api/admin/apps/${APP}/disable`, { method: "POST", body: { reason: "Sexual content" } });
  assert.equal(off.status, 200);
  assert.equal(off.data.disabled, true);
  assert.ok(f.calls.updates[0].patch.disabled_at, "records the moment it was taken down");
  assert.equal(f.calls.updates[0].patch.disabled_reason, "Sexual content");

  const on = await request(f, `/api/admin/apps/${APP}/disable`, { method: "POST", body: { disable: false } });
  assert.equal(on.data.disabled, false);
  assert.equal(on.data.ok, true);
});

test("a malformed app id cannot be disabled", async () => {
  const f = fixture();
  assert.equal((await request(f, "/api/admin/apps/x/disable", { method: "POST", body: {} })).status, 400);
});
