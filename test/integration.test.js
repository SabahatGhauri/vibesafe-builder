// Layer 2 — integration tests. These need a REAL database, but never production.
//
// Point them at a dedicated test environment by setting:
//   TEST_SUPABASE_URL
//   TEST_SUPABASE_ANON_KEY
//   TEST_SUPABASE_SERVICE_ROLE_KEY
//
// Provision that environment first with db/schema.sql, then:
//   npm run test:integration
//
// With those unset the whole suite SKIPS rather than falling back to production
// credentials — that fallback is exactly the risk this layer exists to remove.
//
// The suite boots the real Express app in-process against the test database and
// drives it over HTTP, so it exercises routing, middleware, auth and SQL for
// real; only the environment differs from production.

require("./loadTestEnv");

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");

const URL_ = process.env.TEST_SUPABASE_URL;
const ANON = process.env.TEST_SUPABASE_ANON_KEY;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const configured = Boolean(URL_ && ANON && SERVICE);

if (!configured) {
  test("integration tests (skipped — no test environment configured)", { skip: true }, () => {});
  console.log(
    "\n  Integration tests skipped.\n" +
      "  Set TEST_SUPABASE_URL / TEST_SUPABASE_ANON_KEY / TEST_SUPABASE_SERVICE_ROLE_KEY\n" +
      "  to a dedicated test project provisioned with db/schema.sql.\n" +
      "  Production credentials are deliberately NOT accepted here.\n"
  );
}

describe("integration", { skip: !configured }, () => {
  let server;
  let base;
  let admin;
  const appId = "itest" + Math.random().toString(36).slice(2, 8);

  before(async () => {
    // Env must be set before lib/app.js is required — it reads config at load.
    process.env.SUPABASE_URL = URL_;
    process.env.SUPABASE_ANON_KEY = ANON;
    process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
    process.env.APP_BACKEND_TOKEN_SECRET = "integration-test-secret";
    delete process.env.ISOLATED_APPS_HOST; // would 302 /p/* off localhost

    const app = require("../lib/app");
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, r));
    base = "http://127.0.0.1:" + server.address().port;

    const { createClient } = require("@supabase/supabase-js");
    admin = createClient(URL_, SERVICE);
  });

  after(async () => {
    if (admin) {
      await admin.from("app_records").delete().eq("app_id", appId);
      await admin.from("app_end_users").delete().eq("app_id", appId);
      await admin.from("app_backend_keys").delete().eq("app_id", appId);
      await admin.from("publish_attempts").delete().eq("app_id", appId);
      await admin.from("published_apps").delete().eq("id", appId);
    }
    if (server) await new Promise((r) => server.close(r));
  });

  async function req(path, { method = "GET", headers = {}, body } = {}) {
    const r = await fetch(base + path, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try {
      json = await r.json();
    } catch {}
    return { status: r.status, body: json };
  }

  /* ---------------- schema ---------------- */

  test("every app-backend table exists in the test database", async () => {
    for (const t of ["published_apps", "app_backend_keys", "app_records", "app_end_users", "publish_attempts"]) {
      const { error } = await admin.from(t).select("*").limit(1);
      assert.strictEqual(error, null, t + " missing or unreadable: " + (error && error.message));
    }
  });

  /* ---------------- the RLS boundary ---------------- */
  // The single most important property in the whole system: the anon key ships
  // to every browser, so it must not reach any of these tables. Asserted with
  // real rows present — an empty table returns [] either way and proves nothing.

  test("the anon key cannot read app-backend tables that contain data", async () => {
    await admin.from("published_apps").upsert({ id: appId, html: "<html><head></head><body>t</body></html>" });
    await admin.from("app_backend_keys").upsert({ app_id: appId, app_key: "rls-probe-key" });
    await admin.from("app_records").insert({ app_id: appId, collection: "probe", data: { seen: true } });

    const { createClient } = require("@supabase/supabase-js");
    const anon = createClient(URL_, ANON);

    for (const t of ["app_backend_keys", "app_records", "app_end_users"]) {
      const { data } = await anon.from(t).select("*");
      assert.deepStrictEqual(data || [], [], t + " is readable with the anon key");
    }
    // Control: the anon key itself works, so the empties above are RLS, not a dud key.
    const { data: pub } = await anon.from("published_apps").select("id").eq("id", appId);
    assert.strictEqual((pub || []).length, 1, "anon key cannot read published_apps — control failed");

    await admin.from("app_records").delete().eq("app_id", appId);
  });

  // Regression guard for the vulnerability documented in docs/security-notes.md:
  // published_apps carried `for update using (true)` / `for insert with check (true)`
  // policies (needed because /api/publish used to write through the anon client), so
  // anyone holding the public anon key could overwrite anyone else's published app.
  // Combined with the Phase 1a injected app key, that let an attacker replace an
  // app's HTML and then act as that app against /api/backend.
  test("the anon key cannot overwrite someone else's published app", async () => {
    const victim = appId + "v";
    await admin.from("published_apps").upsert({ id: victim, html: "<html><head></head><body>original</body></html>" });

    const { createClient } = require("@supabase/supabase-js");
    const anon = createClient(URL_, ANON);
    await anon.from("published_apps").update({ html: "<html><body>PWNED</body></html>" }).eq("id", victim);

    const { data } = await admin.from("published_apps").select("html").eq("id", victim).single();
    await admin.from("published_apps").delete().eq("id", victim);
    assert.ok(!data.html.includes("PWNED"), "anon key was able to overwrite another app's HTML");
  });

  test("the anon key cannot insert arbitrary published apps", async () => {
    const { createClient } = require("@supabase/supabase-js");
    const anon = createClient(URL_, ANON);
    const rogue = appId + "r";
    await anon.from("published_apps").insert({ id: rogue, html: "<html></html>" });
    const { data } = await admin.from("published_apps").select("id").eq("id", rogue);
    await admin.from("published_apps").delete().eq("id", rogue);
    assert.strictEqual((data || []).length, 0, "anon key was able to insert a published_apps row");
  });

  test("the anon key cannot write to app_records", async () => {
    const { createClient } = require("@supabase/supabase-js");
    const anon = createClient(URL_, ANON);
    const { error } = await anon.from("app_records").insert({ app_id: appId, collection: "x", data: {} });
    assert.ok(error, "anon insert into app_records should be rejected by RLS");
  });

  /* ---------------- publish ---------------- */

  test("publish provisions a backend key and injects it into the HTML", async () => {
    const r = await req("/api/publish", {
      method: "POST",
      body: {
        code: "<html><head><title>IT</title></head><body>hi</body></html>",
        id: appId,
        publishKey: "it-" + appId,
      },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.body.backendReady, true);

    const page = await fetch(base + "/p/" + appId).then((x) => x.text());
    assert.ok(page.includes('window.VIBESAFE_APP_ID="' + appId + '"'));
    assert.match(page, /VIBESAFE_APP_KEY="[^"]+"/);
    assert.ok(!/service_role/i.test(page), "service-role key leaked into a published app");
  });

  test("a replayed publishKey returns the original result instead of republishing", async () => {
    const r = await req("/api/publish", {
      method: "POST",
      body: {
        code: "<html><head><title>IT</title></head><body>hi</body></html>",
        id: appId,
        publishKey: "it-" + appId,
      },
    });
    assert.strictEqual(r.body.replayed, true);
  });

  test("the security scan blocks a publish containing a hardcoded secret", async () => {
    const r = await req("/api/publish", {
      method: "POST",
      body: {
        code: '<html><head></head><body><script>const apiKey = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";</script></body></html>',
        id: appId + "x",
      },
    });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.body.stage, "security_check");
  });

  /* ---------------- records + end users ---------------- */

  test("records and per-user privacy work end to end", async () => {
    const page = await fetch(base + "/p/" + appId).then((x) => x.text());
    const appKey = page.match(/VIBESAFE_APP_KEY="([^"]+)"/)[1];
    const H = { "x-app-id": appId, "x-app-key": appKey };

    const anonRec = await req("/api/backend/records", {
      method: "POST",
      headers: H,
      body: { collection: "guestbook", data: { msg: "hello" } },
    });
    assert.strictEqual(anonRec.status, 201);
    assert.strictEqual(anonRec.body.shared, true);
    assert.strictEqual(anonRec.body.ownerId, null);

    const alice = await req("/api/backend/auth/signup", {
      method: "POST",
      headers: H,
      body: { username: "alice", password: "alice-password-1" },
    });
    assert.strictEqual(alice.status, 201);
    const aliceH = { ...H, authorization: "Bearer " + alice.body.token };

    const bob = await req("/api/backend/auth/signup", {
      method: "POST",
      headers: H,
      body: { username: "bob", password: "bob-password-11" },
    });
    const bobH = { ...H, authorization: "Bearer " + bob.body.token };

    const priv = await req("/api/backend/records", {
      method: "POST",
      headers: aliceH,
      body: { collection: "notes", data: { secret: "alice-only" } },
    });
    assert.strictEqual(priv.body.shared, false);

    assert.strictEqual((await req("/api/backend/records/" + priv.body.id, { headers: bobH })).status, 404);
    assert.strictEqual((await req("/api/backend/records/" + priv.body.id, { headers: H })).status, 404);
    assert.strictEqual((await req("/api/backend/records/" + priv.body.id, { headers: aliceH })).status, 200);

    const bobList = await req("/api/backend/records?collection=notes", { headers: bobH });
    assert.strictEqual(bobList.body.records.length, 0);
  });

  test("app credentials are required and validated", async () => {
    assert.strictEqual((await req("/api/backend/records?collection=x")).status, 401);
    assert.strictEqual(
      (await req("/api/backend/records?collection=x", { headers: { "x-app-id": appId, "x-app-key": "nope" } })).status,
      401
    );
  });
});
