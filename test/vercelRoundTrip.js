// Phase 3A round-trip against the TEST environment.
//
// Unit tests prove the logic; this proves the whole path — a real signed-in
// user, the real database, the real Vercel API. It is deliberately a script
// rather than part of `npm test`, because it needs credentials and it creates
// a real deployment.
//
// It refuses to run against anything but the test Supabase project.

require("./loadTestEnv");

const URL_ = process.env.TEST_SUPABASE_URL;
const ANON = process.env.TEST_SUPABASE_ANON_KEY;
const SERVICE = process.env.TEST_SUPABASE_SERVICE_ROLE_KEY;
const VTOKEN = process.env.TEST_VERCEL_TOKEN;

if (!URL_ || !ANON || !SERVICE || !VTOKEN) {
  console.error("Missing TEST_* credentials in .env.test — refusing to run.");
  process.exit(1);
}
// The guard that matters: production credentials must be incapable of reaching
// this script, even by accident.
if (process.env.SUPABASE_URL && process.env.SUPABASE_URL !== URL_) {
  console.error("A non-test SUPABASE_URL is set. Refusing to run.");
  process.exit(1);
}

process.env.SUPABASE_URL = URL_;
process.env.SUPABASE_ANON_KEY = ANON;
process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE;
process.env.PORT = "3198";

const { createClient } = require("@supabase/supabase-js");
const vercelLib = require("../lib/deployVercel");
const { withScaffold } = require("../lib/multifile");

const admin = createClient(URL_, SERVICE, { auth: { persistSession: false } });
const anon = createClient(URL_, ANON, { auth: { persistSession: false } });

const BASE = "http://127.0.0.1:3198";
let pass = 0;
let fail = 0;

function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log("  ✓ " + name);
  } else {
    fail++;
    console.log("  ✗ " + name + (detail ? " — " + detail : ""));
  }
}

async function api(session, method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(session ? { "x-vc-session": session } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

(async () => {
  console.log("Target: " + URL_);
  console.log("");

  require("../server.js");
  await new Promise((r) => setTimeout(r, 1200));

  // A throwaway user, deleted at the end whatever happens.
  const email = `vercel-rt-${Date.now()}@vibesafe.test`;
  const password = "test-password-" + Math.random().toString(36).slice(2);
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createErr) {
    console.error("Could not create the test user:", createErr.message);
    process.exit(1);
  }
  const userId = created.user.id;
  const { data: signedIn, error: signInErr } = await anon.auth.signInWithPassword({ email, password });
  if (signInErr) {
    console.error("Could not sign in the test user:", signInErr.message);
    await admin.auth.admin.deleteUser(userId);
    process.exit(1);
  }
  const session = signedIn.session.access_token;

  let deploymentId = null;

  try {
    console.log("1. Authentication");
    check("an unauthenticated caller is refused", (await api(null, "GET", "/api/vercel/status")).status === 401);
    const before = await api(session, "GET", "/api/vercel/status");
    check("a signed-in user with no connection reports not connected", before.body.connected === false);

    console.log("");
    console.log("2. Connecting");
    const bad = await api(session, "POST", "/api/vercel/connect", { token: "vcp_definitely_not_valid" });
    check("an invalid token is rejected", bad.status === 400, JSON.stringify(bad.body));
    const { count: afterBad } = await admin
      .from("vercel_connections")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId);
    check("a rejected token is not stored", afterBad === 0);

    const conn = await api(session, "POST", "/api/vercel/connect", { token: VTOKEN });
    check("a valid token connects", conn.status === 200 && conn.body.connected === true, JSON.stringify(conn.body));
    check("the token's scope is detected as project-scoped", conn.body.scope === "project", conn.body.scope);
    check("no warning for the narrowest scope", conn.body.warning === null);

    console.log("");
    console.log("3. Credential handling (the part that matters)");
    const { data: row } = await admin.from("vercel_connections").select("*").eq("user_id", userId).single();
    check("the stored value is not the plaintext token", row.access_token !== VTOKEN);
    check("the stored value decrypts back to the token", vercelLib.decrypt(row.access_token) === VTOKEN);
    check("the plaintext token appears nowhere in the row", !JSON.stringify(row).includes(VTOKEN));
    check("the connect response never returned the token", !JSON.stringify(conn.body).includes(VTOKEN));
    const st = await api(session, "GET", "/api/vercel/status");
    check("the status response never returns the token", !JSON.stringify(st.body).includes(VTOKEN));
    check("the UI gets a masked hint instead", /^vcp_.{0,4}•+.{4}$/.test(row.token_hint), row.token_hint);

    // RLS with no policies is the real boundary. If the anon key can read this
    // table, the encryption is the only thing left standing.
    const { data: anonRead, error: anonErr } = await anon.from("vercel_connections").select("*");
    check(
      "the public anon key cannot read stored credentials",
      Boolean(anonErr) || (anonRead || []).length === 0,
      anonErr ? anonErr.message : `anon read ${(anonRead || []).length} rows`
    );

    console.log("");
    console.log("4. Test connection");
    const t = await api(session, "POST", "/api/vercel/test", {});
    check("the stored credential still works", t.body.ok === true, JSON.stringify(t.body));

    console.log("");
    console.log("5. Protection detection (detect only)");
    check("protection state is reported", st.body.protection && st.body.protection.protected !== undefined);
    console.log("     protected: " + st.body.protection.protected);
    if (st.body.protection.explanation) console.log("     " + st.body.protection.explanation);

    console.log("");
    console.log("6. Deploying");
    const files = withScaffold(
      {
        "src/main.jsx":
          'import React from "react";\nimport ReactDOM from "react-dom/client";\nimport App from "./App.jsx";\nReactDOM.createRoot(document.getElementById("root")).render(<App />);\n',
        "src/App.jsx":
          'import React from "react";\nexport default function App(){ return <h1>Round trip ' +
          Date.now() +
          "</h1>; }\n",
      },
      { name: "vibesafe-deploy-test" }
    );

    check("deploying nothing is refused", (await api(session, "POST", "/api/vercel/deploy", { files: {} })).status === 400);
    check(
      "an unknown environment is refused",
      (await api(session, "POST", "/api/vercel/deploy", { files, environment: "staging" })).status === 400
    );

    const dep = await api(session, "POST", "/api/vercel/deploy", { files, environment: "preview" });
    check("a preview deployment is created", dep.status === 200 && Boolean(dep.body.id), JSON.stringify(dep.body).slice(0, 200));
    deploymentId = dep.body.id;
    console.log("     " + dep.body.url);

    console.log("");
    console.log("7. Build status");
    let final = null;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const s = await api(session, "GET", "/api/vercel/deployment/" + encodeURIComponent(deploymentId));
      process.stdout.write(" " + s.body.state);
      if (["READY", "ERROR", "CANCELED"].includes(s.body.state)) {
        final = s.body;
        break;
      }
    }
    console.log("");
    check("the build reached READY", final && final.state === "READY", final ? final.error || final.state : "timed out");

    console.log("");
    console.log("8. Audit log");
    const events = await api(session, "GET", "/api/vercel/events");
    const deployEvent = (events.body.events || []).find((e) => e.event === "deploy");
    check("the deployment was recorded", Boolean(deployEvent));
    check("it recorded the environment", deployEvent && deployEvent.environment === "preview");
    check("it recorded the URL", Boolean(deployEvent && deployEvent.url));

    const hist = await api(session, "GET", "/api/vercel/deployments");
    check("deployment history is readable", (hist.body.deployments || []).length > 0);

    console.log("");
    console.log("9. Changing protection through the route (Phase 3B)");
    const startProtection = (await api(session, "GET", "/api/vercel/status")).body.protection;
    console.log("     starting state: protected=" + startProtection.protected + " sso=" + startProtection.sso);
    let madePublic = false;

    try {
      // The confirmation gate, against the real thing.
      const noConfirm = await api(session, "POST", "/api/vercel/protection", { action: "disable" });
      check("a change without confirmation is refused", noConfirm.status === 400);
      const wrongName = await api(session, "POST", "/api/vercel/protection", {
        action: "disable",
        confirmProjectName: "not-the-project",
      });
      check("a change confirming the WRONG project is refused", wrongName.status === 400);
      const badAction = await api(session, "POST", "/api/vercel/protection", {
        action: "nuke",
        confirmProjectName: "vibesafe-deploy-test",
      });
      check("an unknown action is refused", badAction.status === 400);

      // Not a mock this time: a project containing a real-shaped credential,
      // scanned by the actual Launch Check gate, against the actual route.
      // Proves the thing the user explicitly asked for end-to-end — "App with
      // secret: Build -> Scan -> CRITICAL -> Block -> Not public" — rather than
      // only against the mocked Vercel API in the unit suite.
      const filesWithSecret = {
        ...files,
        "src/leaked.js": 'export const key = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";\n',
      };
      const shouldBlock = await api(session, "POST", "/api/vercel/protection", {
        action: "disable",
        confirmProjectName: "vibesafe-deploy-test",
        files: filesWithSecret,
      });
      check("Make Public is blocked when the project has a live credential", shouldBlock.status === 422, JSON.stringify(shouldBlock.body).slice(0, 200));
      check("the block is not overridable for a critical finding", shouldBlock.body.overridable === false);
      const stillProtected = (await api(session, "GET", "/api/vercel/status")).body.protection;
      check(
        "the project is still protected after the blocked attempt",
        stillProtected.protected === startProtection.protected,
        "was " + startProtection.protected + ", now " + stillProtected.protected
      );

      const pub = await api(session, "POST", "/api/vercel/protection", {
        action: "disable",
        confirmProjectName: "vibesafe-deploy-test",
        files,
      });
      madePublic = pub.status === 200 && pub.body.applied === true;
      check("Make Public applies once the secret is removed", madePublic, JSON.stringify(pub.body).slice(0, 200));
      check("the site is verified as genuinely reachable", pub.body.access && pub.body.access.public === true,
        pub.body.access ? pub.body.access.reason : "no access check ran");

      const ev = (await api(session, "GET", "/api/vercel/events")).body.events.find(
        (e) => e.event === "protection_disabled"
      );
      check("the change is in the audit log", Boolean(ev));
      check("the audit log records the state before the change", Boolean(ev && ev.detail && ev.detail.before));
    } finally {
      // Restore whatever was there, pass or fail.
      if (madePublic) {
        const priv = await api(session, "POST", "/api/vercel/protection", {
          action: "enable",
          confirmProjectName: "vibesafe-deploy-test",
        });
        check("Make Private restores protection", priv.body && priv.body.applied === true);
        const now = (await api(session, "GET", "/api/vercel/status")).body.protection;
        check(
          "the ORIGINAL mode was restored, not a default",
          now.sso === startProtection.sso,
          "was " + startProtection.sso + ", now " + now.sso
        );
      }
    }

    console.log("");
    console.log("10. Disconnecting");
    const dis = await api(session, "POST", "/api/vercel/disconnect", {});
    check("disconnect succeeds", dis.body.disconnected === true);
    const { count: afterDisc } = await admin
      .from("vercel_connections")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId);
    check("the credential is gone", afterDisc === 0);
    const { count: eventsLeft } = await admin
      .from("deployment_events")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId);
    check("the audit trail survives the disconnect", eventsLeft > 0, String(eventsLeft));
    check(
      "deploying after disconnect is refused",
      (await api(session, "POST", "/api/vercel/deploy", { files })).status === 403
    );
  } finally {
    // The user cascade-deletes its rows, so the test project is left clean.
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    console.log("");
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
