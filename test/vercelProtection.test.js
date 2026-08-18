// Phase 3B — changing Deployment Protection.
//
// Turning protection off makes a site readable by the whole internet. These
// tests exist to make that impossible to do by accident and impossible to aim
// at the wrong project, and to make sure we never tell someone their site is
// public when it isn't.

const { test } = require("node:test");
const assert = require("node:assert");

const { fakeSupabase, stubVercel, makeApp, call, connected } = require("./vercelHarness");

const PROTECTED = { ssoProtection: { deploymentType: "all_except_custom_domains" } };
const UNPROTECTED = {};

// A project whose protection state actually changes when PATCHed, so the
// read-back that setProtection() performs sees the new value — which is the
// whole point of reading it back. A fixture that always returned the old state
// would make the "did it work?" check untestable.
function project(initial) {
  let state = initial;
  return {
    "/v9/projects/prj_1": (opts) => {
      if (opts.method === "PATCH") {
        const body = JSON.parse(opts.body);
        state = body.ssoProtection ? { ssoProtection: body.ssoProtection } : UNPROTECTED;
      }
      return { body: state };
    },
    "/v6/deployments": { body: { deployments: [] } },
  };
}

// Protected to start with; disabling should take effect.
const disableWorks = () => project(PROTECTED);

/* ---------------- who may change it ---------------- */

test("changing protection requires a connection", async () => {
  const r = await call(makeApp({ supabaseAdmin: fakeSupabase() }), "POST", "/api/vercel/protection", {
    action: "disable",
    confirmProjectName: "my-app",
  });
  assert.strictEqual(r.status, 403);
});

test("an unauthenticated caller cannot change protection", async () => {
  const app = makeApp({ supabaseAdmin: connected(), user: null });
  const r = await call(app, "POST", "/api/vercel/protection", { action: "disable", confirmProjectName: "my-app" });
  assert.strictEqual(r.status, 401);
});

test("an unknown action is refused", async () => {
  const r = await call(makeApp({ supabaseAdmin: connected() }), "POST", "/api/vercel/protection", {
    action: "delete-everything",
    confirmProjectName: "my-app",
  });
  assert.strictEqual(r.status, 400);
});

/* ---------------- the confirmation gate ---------------- */

// The central guard. A boolean `confirm: true` is something a bug can send by
// accident; a project name is something a person has to type.
test("protection cannot be changed without typing the project name", async () => {
  const s = stubVercel({ "/v9/projects/prj_1": { body: PROTECTED } });
  try {
    for (const bad of [undefined, "", "  ", true, 1, "My-App", "wrong-project", "my-app-2"]) {
      const r = await call(makeApp({ supabaseAdmin: connected() }), "POST", "/api/vercel/protection", {
        action: "disable",
        confirmProjectName: bad,
      });
      assert.strictEqual(r.status, 400, `confirmProjectName ${JSON.stringify(bad)} should be refused`);
    }
    assert.deepStrictEqual(
      s.calls.filter((c) => c.method === "PATCH"),
      [],
      "nothing may be written without confirmation"
    );
  } finally {
    s.restore();
  }
});

// Trailing whitespace from a copy-paste is a typing artefact, not a different
// project — accept it rather than blaming someone for an invisible character.
test("the confirmation tolerates surrounding whitespace", async () => {
  const s = stubVercel(disableWorks());
  try {
    const r = await call(makeApp({ supabaseAdmin: connected() }), "POST", "/api/vercel/protection", {
      action: "disable",
      confirmProjectName: "  my-app  ",
    });
    assert.strictEqual(r.status, 200);
  } finally {
    s.restore();
  }
});

/* ---------------- blast radius ---------------- */

test("only the selected project is ever touched", async () => {
  const s = stubVercel(disableWorks());
  try {
    await call(makeApp({ supabaseAdmin: connected() }), "POST", "/api/vercel/protection", {
      action: "disable",
      confirmProjectName: "my-app",
    });
    const patches = s.calls.filter((c) => c.method === "PATCH");
    assert.strictEqual(patches.length, 1, "exactly one project should be modified");
    assert.ok(patches[0].url.includes("prj_1"), "the wrong project was modified: " + patches[0].url);
    assert.ok(
      !s.calls.some((c) => c.method !== "GET" && /\/v\d+\/(teams|user)/.test(c.url)),
      "an account-level or team-level write was attempted"
    );
  } finally {
    s.restore();
  }
});

test("disabling sends ssoProtection: null", async () => {
  const s = stubVercel(disableWorks());
  try {
    await call(makeApp({ supabaseAdmin: connected() }), "POST", "/api/vercel/protection", {
      action: "disable",
      confirmProjectName: "my-app",
    });
    assert.strictEqual(s.calls.find((c) => c.method === "PATCH").body.ssoProtection, null);
  } finally {
    s.restore();
  }
});

/* ---------------- did it actually work ---------------- */

// Vercel answering 200 means it accepted the request, not that the setting
// changed. Reporting success on that basis is the worst bug available here:
// someone would believe their site is public when it is not.
test("a change that did not take effect is reported as failed", async () => {
  const s = stubVercel({ "/v9/projects/prj_1": { body: PROTECTED } }); // still protected after PATCH
  try {
    const r = await call(makeApp({ supabaseAdmin: connected() }), "POST", "/api/vercel/protection", {
      action: "disable",
      confirmProjectName: "my-app",
    });
    assert.strictEqual(r.body.applied, false);
    assert.match(r.body.error, /didn't change/);
  } finally {
    s.restore();
  }
});

test("public accessibility is verified by actually fetching the site", async () => {
  const s = stubVercel({
    ...disableWorks(),
    "/v6/deployments": { body: { deployments: [{ uid: "dpl_1", url: "live.vercel.app", readyState: "READY" }] } },
  });
  const outer = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes("live.vercel.app")) return { status: 200, headers: { get: () => null } };
    return outer(url, opts);
  };
  try {
    const r = await call(makeApp({ supabaseAdmin: connected() }), "POST", "/api/vercel/protection", {
      action: "disable",
      confirmProjectName: "my-app",
    });
    assert.strictEqual(r.body.applied, true);
    assert.strictEqual(r.body.access.public, true);
  } finally {
    global.fetch = outer;
    s.restore();
  }
});

// The failure this catches: Vercel says protection is off, but visitors are
// still bounced to a login page. Believing the API over the observation would
// hand someone a link that does not work for anyone but them.
test("a site still redirecting to Vercel login is reported as NOT public", async () => {
  const s = stubVercel({
    ...disableWorks(),
    "/v6/deployments": { body: { deployments: [{ uid: "dpl_1", url: "live.vercel.app", readyState: "READY" }] } },
  });
  const outer = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes("live.vercel.app")) {
      return { status: 302, headers: { get: (h) => (h === "location" ? "https://vercel.com/sso-api?url=x" : null) } };
    }
    return outer(url, opts);
  };
  try {
    const r = await call(makeApp({ supabaseAdmin: connected() }), "POST", "/api/vercel/protection", {
      action: "disable",
      confirmProjectName: "my-app",
    });
    assert.strictEqual(r.body.applied, true, "the setting itself did change");
    assert.strictEqual(r.body.access.public, false, "but visitors still cannot see it");
    assert.match(r.body.access.reason, /login page/);
  } finally {
    global.fetch = outer;
    s.restore();
  }
});

/* ---------------- the audit trail ---------------- */

test("the change is recorded with the state before AND after", async () => {
  const db = connected();
  const s = stubVercel(disableWorks());
  try {
    await call(makeApp({ supabaseAdmin: db }), "POST", "/api/vercel/protection", {
      action: "disable",
      confirmProjectName: "my-app",
    });
    const ev = db._tables.deployment_events.find((e) => e.event === "protection_disabled");
    assert.ok(ev, "no audit event recorded");
    assert.strictEqual(ev.detail.before.protected, true);
    assert.strictEqual(ev.detail.after.protected, false);
    assert.strictEqual(ev.project_name, "my-app");
  } finally {
    s.restore();
  }
});

/* ---------------- restoring ---------------- */

test("re-enabling restores the mode the project was on before", async () => {
  const db = connected();
  // Someone who only protected PREVIEWS must not come back protecting everything.
  db._tables.deployment_events.push({
    user_id: "user-1",
    event: "protection_disabled",
    detail: { before: { protected: true, sso: "preview" } },
    created_at: new Date().toISOString(),
  });
  const s = stubVercel(project(UNPROTECTED));
  try {
    const r = await call(makeApp({ supabaseAdmin: db }), "POST", "/api/vercel/protection", {
      action: "enable",
      confirmProjectName: "my-app",
    });
    assert.strictEqual(r.body.applied, true);
    const patch = s.calls.find((c) => c.method === "PATCH");
    assert.strictEqual(patch.body.ssoProtection.deploymentType, "preview", "did not restore the previous mode");
  } finally {
    s.restore();
  }
});

test("with no history, re-enabling falls back to protecting everything", async () => {
  const s = stubVercel(project(UNPROTECTED));
  try {
    await call(makeApp({ supabaseAdmin: connected() }), "POST", "/api/vercel/protection", {
      action: "enable",
      confirmProjectName: "my-app",
    });
    const patch = s.calls.find((c) => c.method === "PATCH");
    assert.strictEqual(patch.body.ssoProtection.deploymentType, "all_except_custom_domains");
  } finally {
    s.restore();
  }
});

/* ---------------- permissions ---------------- */

// A project-scoped token may well not carry permission to change settings.
// That is a plausible real outcome, so it needs a message that says what to do.
test("a token without permission to change settings says so usefully", async () => {
  const s = stubVercel({
    "/v9/projects/prj_1": (opts) =>
      opts.method === "PATCH" ? { status: 403, body: { error: { message: "Forbidden" } } } : { body: PROTECTED },
  });
  try {
    const r = await call(makeApp({ supabaseAdmin: connected() }), "POST", "/api/vercel/protection", {
      action: "disable",
      confirmProjectName: "my-app",
    });
    assert.strictEqual(r.status, 403);
    assert.match(r.body.error, /Vercel dashboard/);
  } finally {
    s.restore();
  }
});
