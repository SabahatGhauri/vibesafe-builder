// Offline tests for the Vercel HTTP surface.
//
// These run against a real Express app with a fake Supabase and a fake Vercel
// API, so every route is exercised end to end without a database and without
// network access. The properties being pinned down are the security ones:
// authentication, credential confinement, and the fact that Phase 3A never
// modifies a customer's protection setting.

const { test } = require("node:test");
const assert = require("node:assert");

const vercelLib = require("../lib/deployVercel");
const { fakeSupabase, stubVercel, makeApp, call, connected, PROJECT, OK_TOKEN, NO_ACCOUNT } = require("./vercelHarness");

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
