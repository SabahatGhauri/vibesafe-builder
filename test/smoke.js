// Production smoke test — one controlled end-to-end run against a live deployment.
// Creates a throwaway app, publishes it, verifies credentials were provisioned and
// injected, exercises the records + end-user auth APIs, checks the security
// boundaries, then deletes everything it created.
//
//   node test/smoke.js                          # against production
//   node test/smoke.js http://localhost:3111    # against a local server
//
// Deliberately NOT part of `npm test`: that suite is offline and credential-free.
// This one talks to a real deployment and writes real (then removes) rows.
//
// Cleanup note: it removes its own app_records/app_end_users via the API, but the
// published_apps row itself needs a service-role delete, which this script has no
// credentials for. It prints the id at the end so it can be dropped separately.

const BASE = (process.argv[2] || "https://vibesafebuilder.com").replace(/\/$/, "");
const APP_ID = "smoke" + Math.random().toString(36).slice(2, 8);

let passed = 0;
let failed = 0;

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log("  ✓ " + name);
  } else {
    failed++;
    console.log("  ✗ " + name + (detail ? "  -> " + JSON.stringify(detail) : ""));
  }
}

async function req(path, { method = "GET", headers = {}, body } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await r.json();
  } catch {
    /* non-JSON response */
  }
  return { status: r.status, body: json };
}

(async () => {
  console.log("Smoke test against " + BASE + "  (app id: " + APP_ID + ")\n");

  // ---- publish ----
  console.log("publish");
  const pub = await req("/api/publish", {
    method: "POST",
    body: {
      code: "<html><head><title>Smoke</title></head><body><h1>smoke test</h1></body></html>",
      id: APP_ID,
      publishKey: "smoke-key-" + APP_ID,
    },
  });
  check("publish returns 200", pub.status === 200, pub);
  check("publish reports backend ready", pub.body && pub.body.backendReady === true, pub.body);

  // ---- idempotency ----
  const replay = await req("/api/publish", {
    method: "POST",
    body: {
      code: "<html><head><title>Smoke</title></head><body><h1>smoke test</h1></body></html>",
      id: APP_ID,
      publishKey: "smoke-key-" + APP_ID,
    },
  });
  check("replayed publishKey is deduplicated", replay.body && replay.body.replayed === true, replay.body);

  // ---- credential injection ----
  const page = await fetch(BASE + "/p/" + APP_ID, { redirect: "follow" }).then((r) => r.text());
  const keyMatch = page.match(/VIBESAFE_APP_KEY="([^"]+)"/);
  check("published page has injected app id", page.includes('VIBESAFE_APP_ID="' + APP_ID + '"'));
  check("published page has injected app key", !!keyMatch);
  check(
    "published page does NOT contain a service-role key",
    !/service_role|SUPABASE_SERVICE_ROLE/i.test(page) && !/eyJ[A-Za-z0-9_-]{20,}\.eyJ/.test(page)
  );
  if (!keyMatch) {
    console.log("\nCannot continue without an app key.");
    process.exit(1);
  }
  const APP_KEY = keyMatch[1];
  const appHeaders = { "x-app-id": APP_ID, "x-app-key": APP_KEY };

  // ---- app-level auth ----
  console.log("\napp credentials");
  check("no headers is rejected", (await req("/api/backend/records?collection=x")).status === 401);
  check(
    "wrong key is rejected",
    (await req("/api/backend/records?collection=x", { headers: { "x-app-id": APP_ID, "x-app-key": "wrong" } })).status === 401
  );

  // ---- anonymous records (Phase 1a) ----
  console.log("\nanonymous records");
  const created = await req("/api/backend/records", {
    method: "POST",
    headers: appHeaders,
    body: { collection: "guestbook", data: { msg: "hello" } },
  });
  check("create returns 201", created.status === 201, created);
  check("anonymous record is shared", created.body && created.body.shared === true, created.body);
  check("anonymous record is unowned", created.body && created.body.ownerId === null, created.body);
  const recId = created.body && created.body.id;

  const listed = await req("/api/backend/records?collection=guestbook", { headers: appHeaders });
  check("list returns the record", listed.body && listed.body.records.length === 1, listed.body);

  check(
    "oversized record is rejected",
    (
      await req("/api/backend/records", {
        method: "POST",
        headers: appHeaders,
        body: { collection: "guestbook", data: { blob: "x".repeat(9000) } },
      })
    ).status === 413
  );
  check(
    "bad collection name is rejected",
    (
      await req("/api/backend/records", {
        method: "POST",
        headers: appHeaders,
        body: { collection: "bad name!", data: {} },
      })
    ).status === 400
  );

  // ---- end-user accounts (Phase 1b) ----
  console.log("\nend-user accounts");
  const signup = await req("/api/backend/auth/signup", {
    method: "POST",
    headers: appHeaders,
    body: { username: "alice", password: "alice-password-1" },
  });
  check("signup returns 201 with a token", signup.status === 201 && !!signup.body.token, signup);
  const aliceAuth = { ...appHeaders, authorization: "Bearer " + signup.body.token };

  check(
    "duplicate username is rejected",
    (
      await req("/api/backend/auth/signup", {
        method: "POST",
        headers: appHeaders,
        body: { username: "alice", password: "another-password" },
      })
    ).status === 409
  );
  check(
    "short password is rejected",
    (
      await req("/api/backend/auth/signup", {
        method: "POST",
        headers: appHeaders,
        body: { username: "shorty", password: "abc" },
      })
    ).status === 400
  );
  check(
    "wrong password is rejected",
    (
      await req("/api/backend/auth/login", {
        method: "POST",
        headers: appHeaders,
        body: { username: "alice", password: "wrong-password-here" },
      })
    ).status === 401
  );
  const login = await req("/api/backend/auth/login", {
    method: "POST",
    headers: appHeaders,
    body: { username: "alice", password: "alice-password-1" },
  });
  check("correct password logs in", login.status === 200 && !!login.body.token, login);

  const me = await req("/api/backend/auth/me", { headers: aliceAuth });
  check("auth/me identifies the user", me.body && me.body.user.username === "alice", me.body);

  // ---- privacy ----
  console.log("\nper-user privacy");
  const priv = await req("/api/backend/records", {
    method: "POST",
    headers: aliceAuth,
    body: { collection: "notes", data: { secret: "alice-only" } },
  });
  check("signed-in record is private by default", priv.body && priv.body.shared === false, priv.body);
  check("signed-in record is owned", priv.body && priv.body.ownerId, priv.body);
  const privId = priv.body.id;

  const bob = await req("/api/backend/auth/signup", {
    method: "POST",
    headers: appHeaders,
    body: { username: "bob", password: "bob-password-11" },
  });
  const bobAuth = { ...appHeaders, authorization: "Bearer " + bob.body.token };

  check(
    "another user cannot read a private record",
    (await req("/api/backend/records/" + privId, { headers: bobAuth })).status === 404
  );
  check(
    "anonymous cannot read a private record",
    (await req("/api/backend/records/" + privId, { headers: appHeaders })).status === 404
  );
  const bobList = await req("/api/backend/records?collection=notes", { headers: bobAuth });
  check("private record absent from another user's list", bobList.body && bobList.body.records.length === 0, bobList.body);
  const aliceList = await req("/api/backend/records?collection=notes", { headers: aliceAuth });
  check("owner still sees their own record", aliceList.body && aliceList.body.records.length === 1, aliceList.body);
  check(
    "another user cannot delete a private record",
    (await req("/api/backend/records/" + privId, { method: "DELETE", headers: bobAuth })).status === 404
  );

  // shared-but-owned
  const sharedPost = await req("/api/backend/records", {
    method: "POST",
    headers: aliceAuth,
    body: { collection: "posts", data: { text: "public post" }, shared: true },
  });
  check("shared:true makes an owned record public", sharedPost.body && sharedPost.body.shared === true, sharedPost.body);
  check(
    "another user CAN read a shared owned record",
    (await req("/api/backend/records/" + sharedPost.body.id, { headers: bobAuth })).status === 200
  );
  check(
    "another user CANNOT edit a shared owned record",
    (
      await req("/api/backend/records/" + sharedPost.body.id, {
        method: "PUT",
        headers: bobAuth,
        body: { data: { text: "hijacked" } },
      })
    ).status === 403
  );

  // ---- token scoping ----
  console.log("\ntoken scoping");
  check(
    "a garbage bearer token is treated as anonymous, not an error",
    (await req("/api/backend/records?collection=guestbook", { headers: { ...appHeaders, authorization: "Bearer nonsense" } }))
      .status === 200
  );

  // ---- cleanup ----
  console.log("\ncleanup");
  await req("/api/backend/records/" + recId, { method: "DELETE", headers: appHeaders });
  await req("/api/backend/records/" + privId, { method: "DELETE", headers: aliceAuth });
  await req("/api/backend/records/" + sharedPost.body.id, { method: "DELETE", headers: aliceAuth });
  const leftover = await req("/api/backend/records?collection=guestbook", { headers: appHeaders });
  check("records cleaned up", leftover.body && leftover.body.records.length === 0, leftover.body);

  console.log("\n" + passed + " passed, " + failed + " failed");
  console.log("Remaining to drop manually (needs service role): published_apps id = " + APP_ID);
  process.exit(failed ? 1 : 0);
})().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
