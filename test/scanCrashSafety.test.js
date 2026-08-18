// Proves the crash-safety fix in lib/vercelRoutes.js: if Launch Check's scanner
// throws instead of returning a result, the route must fail closed — respond
// 422 blocked — rather than crash the process.
//
// WHY THIS IS A SEPARATE FILE
// Node's test runner gives each file its own process (verified empirically —
// see the commit that added this file), which is exactly what this test needs:
// it monkeypatches lib/securityGate's exports and forces lib/vercelRoutes to
// re-require it, so the route's internal `scanProject` binding picks up a
// version that deliberately throws. That surgery must not be able to leak into
// any other test file, and file-per-process isolation guarantees it can't.
//
// THE BUG THIS GUARDS
// This app runs Express 4 with no global error-handling middleware, on a
// Node version where an unhandled rejection from an async route handler
// terminates the whole process — reproduced directly during development: an
// unguarded `throw` in this exact route shape killed the process outright,
// exit code 1, before any response was sent. A future bug in a Launch Check
// rule (a bad regex, an unexpected input shape) must not be able to take the
// entire site down for every user over one malformed project.

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("path");

const securityGatePath = require.resolve("../lib/securityGate");
const vercelRoutesPath = require.resolve("../lib/vercelRoutes");

// Loads a fresh copy of lib/vercelRoutes with lib/securityGate's scanProject
// replaced by one that throws — proving the route's own try/catch is what
// keeps the process alive, not any accident of the current rule set being
// well-behaved.
function loadRoutesWithThrowingScanner() {
  delete require.cache[vercelRoutesPath];
  delete require.cache[securityGatePath];

  const real = require(securityGatePath);
  // Mutate the cached exports object in place. vercelRoutes.js destructures
  // `scanProject` at require time, so it must see this patched value AT THE
  // MOMENT it is (re-)required below, not before.
  const originalScanProject = real.scanProject;
  real.scanProject = () => {
    throw new Error("simulated Launch Check crash — a bug in a scan rule, not a finding");
  };

  delete require.cache[vercelRoutesPath];
  const patched = require(vercelRoutesPath);

  return {
    registerVercelRoutes: patched.registerVercelRoutes,
    restore() {
      real.scanProject = originalScanProject;
      delete require.cache[vercelRoutesPath];
      delete require.cache[securityGatePath];
    },
  };
}

const { fakeSupabase, stubVercel, makeApp: makeAppWithOriginalRoutes, call, connected } = require("./vercelHarness");

// vercelHarness.js already required the real vercelRoutes before this file's
// patching runs, and Node caches by resolved path — so makeApp() there is
// unaffected. Build a parallel app factory using the PATCHED registerVercelRoutes.
function makeAppWithThrowingScanner(registerVercelRoutes, opts) {
  const express = require("express");
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  registerVercelRoutes(app, {
    supabaseAdmin: opts.supabaseAdmin,
    getManagedUser: async () => (opts.user === undefined ? { id: "user-1" } : opts.user),
  });
  return app;
}

const CLEAN_FILES = { "package.json": '{"name":"my-app"}', "src/App.jsx": "export default function App(){}" };

test("a scanner crash on deploy fails closed (422), and the process survives", async (t) => {
  const { registerVercelRoutes, restore } = loadRoutesWithThrowingScanner();
  const app = makeAppWithThrowingScanner(registerVercelRoutes, { supabaseAdmin: connected() });
  try {
    const r = await call(app, "POST", "/api/vercel/deploy", { files: CLEAN_FILES });
    assert.strictEqual(r.status, 422, "a scanner crash must block, not silently pass or 500");
    assert.strictEqual(r.body.blocked, true);
    assert.strictEqual(r.body.overridable, false, "a scan we could not complete must not be overridable");
    assert.match(r.body.reason, /couldn't complete/i);

    // The real proof: if the route's try/catch were missing, this request
    // would have crashed the process before `call()` could even return — the
    // test process is still alive and can make another request.
    const r2 = await call(app, "POST", "/api/vercel/deploy", { files: {} });
    assert.strictEqual(r2.status, 400, "the process survived and can still serve requests");
  } finally {
    restore();
  }
});

test("a scanner crash on Make Public fails closed, and never touches Vercel", async (t) => {
  const { registerVercelRoutes, restore } = loadRoutesWithThrowingScanner();
  const s = stubVercel({ "/v9/projects/prj_1": { body: { ssoProtection: { deploymentType: "all_except_custom_domains" } } } });
  const app = makeAppWithThrowingScanner(registerVercelRoutes, { supabaseAdmin: connected() });
  try {
    const r = await call(app, "POST", "/api/vercel/protection", {
      action: "disable",
      confirmProjectName: "my-app",
      files: CLEAN_FILES,
    });
    assert.strictEqual(r.status, 422);
    assert.strictEqual(r.body.blocked, true);
    assert.deepStrictEqual(
      s.calls.filter((c) => c.method === "PATCH"),
      [],
      "protection must not change when Launch Check itself failed"
    );
  } finally {
    s.restore();
    restore();
  }
});

test("the blocked-by-crash outcome is still recorded in the audit log", async (t) => {
  const { registerVercelRoutes, restore } = loadRoutesWithThrowingScanner();
  const db = connected();
  const app = makeAppWithThrowingScanner(registerVercelRoutes, { supabaseAdmin: db });
  try {
    await call(app, "POST", "/api/vercel/deploy", { files: CLEAN_FILES });
    const ev = db._tables.deployment_events.find((e) => e.event === "deploy_blocked");
    assert.ok(ev, "a scanner crash should still leave an audit trail");
  } finally {
    restore();
  }
});

// A control test: proves the patching technique itself works as intended
// (i.e. this file's harness is trustworthy) by checking the SAME patched
// module, called directly, does in fact throw.
test("control: the patched scanProject genuinely throws when called directly", () => {
  const { restore } = (() => {
    delete require.cache[securityGatePath];
    const real = require(securityGatePath);
    const original = real.scanProject;
    real.scanProject = () => {
      throw new Error("control throw");
    };
    return {
      restore: () => {
        real.scanProject = original;
      },
    };
  })();
  try {
    const sg = require(securityGatePath);
    assert.throws(() => sg.scanProject({}), /control throw/);
  } finally {
    restore();
  }
});
