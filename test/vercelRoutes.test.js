// Offline tests for the Vercel HTTP surface.
//
// These run against a real Express app with a fake Supabase and a fake Vercel
// API, so every route is exercised end to end without a database and without
// network access. The properties being pinned down are the security ones:
// authentication, credential confinement, and the fact that Phase 3A never
// modifies a customer's protection setting.

const { test } = require("node:test");
const assert = require("node:assert");
const express = require("express");

const { registerVercelRoutes } = require("../lib/vercelRoutes");
const vercelLib = require("../lib/deployVercel");

/* ---------------- harness ---------------- */

// A Supabase stand-in that keeps rows in memory and records every write, so a
// test can assert on what was actually persisted rather than on a return value.
function fakeSupabase(seed = {}) {
  const tables = { vercel_connections: [], deployment_events: [], ...seed };
  function from(name) {
    const rows = (tables[name] = tables[name] || []);
    const filters = [];
    const q = {
      select() {
        return q;
      },
      eq(col, val) {
        filters.push([col, val]);
        return q;
      },
      order() {
        return q;
      },
      limit() {
        return Promise.resolve({ data: rows.filter(match), error: null });
      },
      maybeSingle() {
        return Promise.resolve({ data: rows.find(match) || null, error: null });
      },
      insert(row) {
        rows.push(row);
        return Promise.resolve({ error: null });
      },
      upsert(row) {
        const i = rows.findIndex((r) => r.user_id === row.user_id);
        if (i >= 0) rows[i] = { ...rows[i], ...row };
        else rows.push(row);
        return Promise.resolve({ error: null });
      },
      delete() {
        return {
          eq(col, val) {
            for (let i = rows.length - 1; i >= 0; i--) if (rows[i][col] === val) rows.splice(i, 1);
            return Promise.resolve({ error: null });
          },
        };
      },
      then(res) {
        return Promise.resolve({ data: rows.filter(match), error: null }).then(res);
      },
    };
    function match(r) {
      return filters.every(([c, v]) => r[c] === v);
    }
    return q;
  }
  return { from, _tables: tables };
}

// Replaces global fetch so no test can reach the real Vercel API. Each entry is
// matched by substring against the request URL.
//
// Only api.vercel.com is intercepted: the request helper below drives the app
// over real HTTP on localhost, and swallowing that too would make every test
// fail identically for a reason that has nothing to do with the code.
function stubVercel(routes) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts = {}) => {
    if (!String(url).includes("api.vercel.com")) return original(url, opts);
    calls.push({ url: String(url), method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
    for (const [frag, reply] of Object.entries(routes)) {
      if (String(url).includes(frag)) {
        const r = typeof reply === "function" ? reply(opts) : reply;
        return { ok: r.status ? r.status < 400 : true, status: r.status || 200, json: async () => r.body };
      }
    }
    return { ok: false, status: 404, json: async () => ({ error: { message: "not stubbed" } }) };
  };
  return { calls, restore: () => (global.fetch = original) };
}

function makeApp({ supabaseAdmin, user = { id: "user-1" } }) {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  registerVercelRoutes(app, { supabaseAdmin, getManagedUser: async () => user });
  return app;
}

// A minimal request helper — starts the app on an ephemeral port, makes one
// call, shuts down. Avoids adding supertest as a dependency.
async function call(app, method, path, body) {
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    server.close();
  }
}

const PROJECT = { id: "prj_1", name: "my-app", framework: "vite" };
const OK_TOKEN = { body: { projects: [PROJECT] } };
const NO_ACCOUNT = { status: 404, body: { error: { message: "not found" } } };

/* ---------------- authentication ---------------- */

test("every route refuses an unauthenticated caller", async () => {
  const app = makeApp({ supabaseAdmin: fakeSupabase(), user: null });
  for (const [m, p] of [
    ["POST", "/api/vercel/connect"],
    ["GET", "/api/vercel/status"],
    ["POST", "/api/vercel/test"],
    ["POST", "/api/vercel/disconnect"],
    ["POST", "/api/vercel/deploy"],
    ["GET", "/api/vercel/deployments"],
    ["GET", "/api/vercel/events"],
  ]) {
    const r = await call(app, m, p, m === "POST" ? {} : undefined);
    assert.strictEqual(r.status, 401, `${m} ${p} should require a session`);
  }
});

test("the whole surface degrades to 503 when storage is unconfigured", async () => {
  const app = makeApp({ supabaseAdmin: null });
  const r = await call(app, "GET", "/api/vercel/status");
  assert.strictEqual(r.status, 503);
});

/* ---------------- connecting ---------------- */

test("connecting validates the token before storing it", async () => {
  const db = fakeSupabase();
  const s = stubVercel({ "/v9/projects": { status: 403, body: { error: { message: "bad" } } } });
  try {
    const r = await call(makeApp({ supabaseAdmin: db }), "POST", "/api/vercel/connect", { token: "vcp_bad" });
    assert.strictEqual(r.status, 400);
    assert.match(r.body.error, /revoked or expired/);
    assert.strictEqual(db._tables.vercel_connections.length, 0, "a rejected token must not be stored");
  } finally {
    s.restore();
  }
});

test("a project-scoped token connects without asking which project", async () => {
  const db = fakeSupabase();
  const s = stubVercel({ "/v9/projects": OK_TOKEN, "/v2/user": NO_ACCOUNT });
  try {
    const r = await call(makeApp({ supabaseAdmin: db }), "POST", "/api/vercel/connect", { token: "vcp_good_token_1234" });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.connected, true);
    assert.strictEqual(r.body.scope, "project");
    assert.strictEqual(r.body.projectName, "my-app");
    assert.strictEqual(r.body.warning, null, "the narrowest scope should not be warned about");
  } finally {
    s.restore();
  }
});

// The single most important property of this whole file.
test("the stored token is encrypted and never returned to the client", async () => {
  const db = fakeSupabase();
  const s = stubVercel({ "/v9/projects": OK_TOKEN, "/v2/user": NO_ACCOUNT });
  const TOKEN = "vcp_good_token_1234";
  try {
    const r = await call(makeApp({ supabaseAdmin: db }), "POST", "/api/vercel/connect", { token: TOKEN });
    const row = db._tables.vercel_connections[0];
    assert.notStrictEqual(row.access_token, TOKEN, "token stored in plaintext");
    assert.strictEqual(vercelLib.decrypt(row.access_token), TOKEN, "token not recoverable by the server");
    assert.ok(!JSON.stringify(r.body).includes(TOKEN), "the response leaked the token");
    assert.ok(!row.token_hint.includes("good_token"), "the hint leaked the token");
  } finally {
    s.restore();
  }
});

test("an over-broad token is accepted but warned about", async () => {
  const db = fakeSupabase();
  const s = stubVercel({ "/v9/projects": OK_TOKEN, "/v2/user": { body: { user: { id: "u" } } } });
  try {
    const r = await call(makeApp({ supabaseAdmin: db }), "POST", "/api/vercel/connect", { token: "vcp_wide_token_1234" });
    assert.strictEqual(r.body.connected, true, "a broad token should still work");
    assert.strictEqual(r.body.scope, "account");
    assert.match(r.body.warning, /whole Vercel account/);
  } finally {
    s.restore();
  }
});

test("a token seeing several projects asks which one, and stores nothing yet", async () => {
  const db = fakeSupabase();
  const s = stubVercel({
    "/v9/projects": { body: { projects: [PROJECT, { id: "prj_2", name: "other" }] } },
    "/v2/user": NO_ACCOUNT,
  });
  try {
    const r = await call(makeApp({ supabaseAdmin: db }), "POST", "/api/vercel/connect", { token: "vcp_team_token_1234" });
    assert.strictEqual(r.body.needsProject, true);
    assert.strictEqual(r.body.projects.length, 2);
    assert.strictEqual(db._tables.vercel_connections.length, 0, "must not store before a project is chosen");
  } finally {
    s.restore();
  }
});

test("an empty token is rejected without calling Vercel", async () => {
  const s = stubVercel({});
  try {
    const r = await call(makeApp({ supabaseAdmin: fakeSupabase() }), "POST", "/api/vercel/connect", { token: "  " });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(s.calls.length, 0, "should not have hit the API");
  } finally {
    s.restore();
  }
});

/* ---------------- status and protection ---------------- */

function connected(extra = {}) {
  return fakeSupabase({
    vercel_connections: [
      {
        user_id: "user-1",
        access_token: vercelLib.encrypt("vcp_stored_token_1234"),
        token_hint: vercelLib.hint("vcp_stored_token_1234"),
        token_scope: "project",
        project_id: "prj_1",
        project_name: "my-app",
        ...extra,
      },
    ],
  });
}

test("status reports not-connected rather than erroring", async () => {
  const r = await call(makeApp({ supabaseAdmin: fakeSupabase() }), "GET", "/api/vercel/status");
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.connected, false);
});

test("status surfaces deployment protection in plain language", async () => {
  const s = stubVercel({
    "/v9/projects/prj_1": { body: { ssoProtection: { deploymentType: "all_except_custom_domains" } } },
  });
  try {
    const r = await call(makeApp({ supabaseAdmin: connected() }), "GET", "/api/vercel/status");
    assert.strictEqual(r.body.connected, true);
    assert.strictEqual(r.body.protection.protected, true);
    assert.match(r.body.protection.explanation, /log in to Vercel/);
    assert.ok(!JSON.stringify(r.body).includes("stored_token"), "status leaked the token");
  } finally {
    s.restore();
  }
});

// Phase 3A is explicitly detect-only. If a future change ever adds a write here,
// this test fails.
test("nothing in Phase 3A ever writes to a project's protection settings", async () => {
  const s = stubVercel({
    "/v9/projects/prj_1": { body: { ssoProtection: { deploymentType: "all_except_custom_domains" } } },
    "/v13/deployments": { body: { id: "dpl_1", url: "x.vercel.app", readyState: "QUEUED", projectId: "prj_1" } },
  });
  try {
    const app = makeApp({ supabaseAdmin: connected() });
    await call(app, "GET", "/api/vercel/status");
    await call(app, "POST", "/api/vercel/deploy", { files: { "src/a.js": "x" } });
    const writes = s.calls.filter((c) => c.method !== "GET" && /\/v\d+\/projects/.test(c.url));
    assert.deepStrictEqual(writes, [], "Phase 3A must not modify project settings");
  } finally {
    s.restore();
  }
});

test("an unreadable protection state does not break status", async () => {
  const s = stubVercel({ "/v9/projects/prj_1": { status: 500, body: { error: { message: "boom" } } } });
  try {
    const r = await call(makeApp({ supabaseAdmin: connected() }), "GET", "/api/vercel/status");
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.protection.protected, null, "unknown, not false");
  } finally {
    s.restore();
  }
});

/* ---------------- deploying ---------------- */

test("a deployment is created and recorded in the audit log", async () => {
  const db = connected();
  const s = stubVercel({
    "/v13/deployments": { body: { id: "dpl_1", url: "my-app.vercel.app", readyState: "QUEUED", projectId: "prj_1" } },
    "/v9/projects/prj_1": { body: {} },
  });
  try {
    const r = await call(makeApp({ supabaseAdmin: db }), "POST", "/api/vercel/deploy", {
      files: { "src/a.js": "x", "package.json": "{}" },
      environment: "production",
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.url, "https://my-app.vercel.app");

    const ev = db._tables.deployment_events[0];
    assert.strictEqual(ev.event, "deploy");
    assert.strictEqual(ev.environment, "production");
    assert.strictEqual(ev.deployment_id, "dpl_1");
    assert.strictEqual(ev.detail.fileCount, 2);
  } finally {
    s.restore();
  }
});

test("preview is the default, and production must be asked for explicitly", async () => {
  const s = stubVercel({
    "/v13/deployments": { body: { id: "dpl_1", url: "x.vercel.app", readyState: "QUEUED" } },
    "/v9/projects/prj_1": { body: {} },
  });
  try {
    await call(makeApp({ supabaseAdmin: connected() }), "POST", "/api/vercel/deploy", { files: { "a.js": "x" } });
    const post = s.calls.find((c) => c.url.includes("/v13/deployments"));
    assert.strictEqual(post.body.target, undefined, "a default deploy must not target production");
  } finally {
    s.restore();
  }
});

test("deploying without a connection is refused before any API call", async () => {
  const s = stubVercel({});
  try {
    const r = await call(makeApp({ supabaseAdmin: fakeSupabase() }), "POST", "/api/vercel/deploy", {
      files: { "a.js": "x" },
    });
    assert.strictEqual(r.status, 403);
    assert.strictEqual(s.calls.length, 0);
  } finally {
    s.restore();
  }
});

test("an unknown environment is rejected", async () => {
  const r = await call(makeApp({ supabaseAdmin: connected() }), "POST", "/api/vercel/deploy", {
    files: { "a.js": "x" },
    environment: "staging",
  });
  assert.strictEqual(r.status, 400);
});

test("deploying nothing is rejected", async () => {
  const r = await call(makeApp({ supabaseAdmin: connected() }), "POST", "/api/vercel/deploy", { files: {} });
  assert.strictEqual(r.status, 400);
});

test("a revoked token produces a reconnect message, not a stack trace", async () => {
  const s = stubVercel({ "/v13/deployments": { status: 403, body: { error: { message: "Forbidden" } } } });
  try {
    const r = await call(makeApp({ supabaseAdmin: connected() }), "POST", "/api/vercel/deploy", {
      files: { "a.js": "x" },
    });
    assert.strictEqual(r.status, 403);
    assert.match(r.body.error, /reconnect/i);
  } finally {
    s.restore();
  }
});

// A rotated encryption key must degrade to "reconnect", not to a crash or, far
// worse, to using a garbage token.
test("an undecryptable stored token is treated as not connected", async () => {
  const db = fakeSupabase({
    vercel_connections: [{ user_id: "user-1", access_token: "not.valid.ciphertext", project_id: "prj_1" }],
  });
  const r = await call(makeApp({ supabaseAdmin: db }), "GET", "/api/vercel/status");
  assert.strictEqual(r.body.connected, false);
});

/* ---------------- disconnecting ---------------- */

test("disconnecting removes the credential but keeps the audit trail", async () => {
  const db = connected();
  db._tables.deployment_events.push({ user_id: "user-1", event: "deploy" });
  const r = await call(makeApp({ supabaseAdmin: db }), "POST", "/api/vercel/disconnect");
  assert.strictEqual(r.body.disconnected, true);
  assert.strictEqual(db._tables.vercel_connections.length, 0, "credential should be gone");
  assert.ok(
    db._tables.deployment_events.some((e) => e.event === "deploy"),
    "history must survive a disconnect"
  );
  assert.ok(
    db._tables.deployment_events.some((e) => e.event === "disconnect"),
    "the disconnect itself should be recorded"
  );
});
