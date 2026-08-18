// Offline unit tests for the deployment layer — the provider interface, the
// artifact preparation that feeds it, and the security gate that now applies to
// every target rather than only our own hosting.

const { test } = require("node:test");
const assert = require("node:assert");

const { prepareArtifact, scanBlockers, getProvider, listProviders, registerProvider, vibesafe } = require("../lib/deploy");
const { withScaffold } = require("../lib/multifile");

const MULTI = withScaffold({
  "src/main.jsx":
    'import React from "react";\nimport ReactDOM from "react-dom/client";\nimport App from "./App.jsx";\nReactDOM.createRoot(document.getElementById("root")).render(<App />);\n',
  "src/App.jsx": 'import React from "react";\nexport default function App(){ return <h1>hi</h1>; }\n',
});
const SINGLE = "<html><head><title>t</title></head><body>hi</body></html>";

/* ---------------- artifact preparation ---------------- */

test("a single-file app uses its own code as both artifact and scan source", () => {
  const a = prepareArtifact({ kind: "single", code: SINGLE });
  assert.strictEqual(a.html, SINGLE);
  assert.strictEqual(a.scanSource, SINGLE);
});

test("a multi-file project assembles into a runnable document", () => {
  const a = prepareArtifact({ kind: "multi", files: MULTI });
  assert.match(a.html, /^<!DOCTYPE html>/);
  assert.ok(a.html.includes("__VS_SOURCES__"));
});

// The single most important property here: the assembled bundle contains our own
// new Function module loader, so scanning IT would trip the eval blocker on every
// multi-file deployment. The scan must read what the model wrote.
test("a multi-file project is scanned on its sources, not the assembled bundle", () => {
  const a = prepareArtifact({ kind: "multi", files: MULTI });
  assert.ok(a.html.includes("new Function"), "precondition: the loader is in the artifact");
  assert.ok(!a.scanSource.includes("new Function"), "scan source must not contain our loader");
  assert.deepStrictEqual(scanBlockers(a.scanSource), [], "a clean project must not be blocked");
});

test("invalid input reports which stage failed", () => {
  assert.throws(() => prepareArtifact({ kind: "single", code: "not html" }), (e) => e.stage === "validating");
  assert.throws(() => prepareArtifact({ kind: "multi", files: { "src/x.js": "y" } }), (e) => e.stage === "validating");
});

/* ---------------- the security gate ---------------- */

// The label now names the provider rather than saying "a secret", because the
// rules moved to lib/securityGate.js and identify what they found.
test("a hardcoded secret is blocked", () => {
  const blockers = scanBlockers('const key = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";');
  assert.ok(blockers.length > 0, "a live API key was not blocked");
  assert.ok(blockers.some((b) => /API key/i.test(b)), "expected the finding to name the credential type: " + blockers);
});

test("eval is blocked", () => {
  assert.ok(scanBlockers("eval('x')").length > 0);
  assert.ok(scanBlockers("new Function('x')").length > 0);
});

test("reading the builder's own storage keys is blocked", () => {
  assert.ok(scanBlockers("localStorage.getItem('vc_apiKey')").length > 0);
});

test("a password in localStorage is blocked", () => {
  assert.ok(scanBlockers('localStorage.setItem("password", p)').length > 0);
});

test("ordinary code is not blocked", () => {
  assert.deepStrictEqual(scanBlockers('const x = 1;\nlocalStorage.setItem("todos", JSON.stringify(t));'), []);
});

/* ---------------- the provider registry ---------------- */

test("VibeSafe hosting is registered and needs no connection", () => {
  const p = getProvider("vibesafe");
  assert.ok(p, "vibesafe provider missing");
  assert.strictEqual(p.needsConnection, false);
  assert.strictEqual(p.id, "vibesafe");
});

test("an unknown provider returns null rather than throwing", () => {
  assert.strictEqual(getProvider("nope"), null);
});

test("availability reflects whether storage is configured", () => {
  assert.strictEqual(vibesafe.isAvailable({ supabase: null, supabaseAdmin: null }), false);
  assert.strictEqual(vibesafe.isAvailable({ supabase: {}, supabaseAdmin: {} }), true);
});

test("listProviders reports availability per provider", () => {
  const list = listProviders({ supabase: {}, supabaseAdmin: {} });
  const vs = list.find((p) => p.id === "vibesafe");
  assert.ok(vs.available);
  assert.strictEqual(vs.name, "VibeSafe Hosting");
});

test("a new provider can register without touching existing ones", () => {
  registerProvider({ id: "test-only", name: "Test", needsConnection: true, isAvailable: () => false });
  const list = listProviders({ supabase: {}, supabaseAdmin: {} });
  assert.ok(list.find((p) => p.id === "test-only"));
  assert.ok(list.find((p) => p.id === "vibesafe"), "registering must not disturb existing providers");
});

/* ---------------- deploying through the provider ---------------- */

// A fake Supabase that records what was written, so the two environments can be
// compared without a database.
function fakeCtx() {
  const writes = [];
  const table = {
    upsert: (row) => {
      writes.push(row);
      return Promise.resolve({ error: null });
    },
  };
  return {
    writes,
    ctx: {
      supabase: { from: () => table },
      supabaseAdmin: { from: () => table },
      randomId: () => "abc123",
      injectPWATags: (html) => html + "<!--pwa-->",
      provisionAppKey: async () => "app-key-xyz",
      injectBackendConfig: (html, { appId, appKey }) => html + `<!--${appId}:${appKey}-->`,
    },
  };
}

test("a production deployment gets PWA tags and backend credentials", async () => {
  const { ctx, writes } = fakeCtx();
  const artifact = prepareArtifact({ kind: "single", code: SINGLE });
  const r = await vibesafe.deploy(ctx, { artifact, environment: "production", appId: "myapp1" });
  assert.strictEqual(r.id, "myapp1");
  assert.strictEqual(r.url, "/p/myapp1");
  assert.strictEqual(r.backendReady, true);
  const final = writes[writes.length - 1].html;
  assert.ok(final.includes("<!--pwa-->"), "PWA tags missing");
  assert.ok(final.includes("myapp1:app-key-xyz"), "backend credentials missing");
});

// A preview is a snapshot to show someone, not a release. Giving it the app's
// backend key would let a work-in-progress link read and write the real data.
test("a preview gets noindex and NO backend credentials", async () => {
  const { ctx, writes } = fakeCtx();
  const artifact = prepareArtifact({ kind: "single", code: SINGLE });
  const r = await vibesafe.deploy(ctx, { artifact, environment: "preview" });
  assert.match(r.id, /^pv/);
  assert.strictEqual(r.backendReady, false);
  const final = writes[writes.length - 1].html;
  assert.ok(final.includes("noindex"), "preview should be noindex");
  assert.ok(!final.includes("app-key-xyz"), "preview must not carry backend credentials");
  assert.ok(!final.includes("<!--pwa-->"), "preview should not be installable");
});

test("a failed backend provision still yields a working deployment", async () => {
  const { ctx, writes } = fakeCtx();
  ctx.provisionAppKey = async () => {
    throw new Error("provisioning is down");
  };
  const artifact = prepareArtifact({ kind: "single", code: SINGLE });
  const r = await vibesafe.deploy(ctx, { artifact, environment: "production", appId: "myapp2" });
  assert.strictEqual(r.backendReady, false, "should report the capability is missing");
  assert.strictEqual(r.url, "/p/myapp2", "but the app itself must still be deployed");
  assert.ok(writes.length >= 1);
});

/* ---------------- Vercel provider ---------------- */

const vercelLib = require("../lib/deployVercel");

test("project files are converted to Vercel's inline format", () => {
  const out = vercelLib.filesToVercel({ "src/App.jsx": "hello\n", "package.json": "{}\n" });
  assert.strictEqual(out.length, 2);
  const app = out.find((f) => f.file === "src/App.jsx");
  assert.strictEqual(app.encoding, "base64");
  assert.strictEqual(Buffer.from(app.data, "base64").toString("utf8"), "hello\n");
});

// Vercel builds from SOURCE, so it must receive package.json and vite.config.js —
// not the assembled preview bundle. Without them there is nothing to build and
// "deploy" degrades to uploading one pre-built HTML file.
test("the build scaffold is included in what gets sent to Vercel", () => {
  const files = withScaffold({ "src/main.jsx": "x\n" });
  const sent = vercelLib.filesToVercel(files).map((f) => f.file);
  for (const f of ["package.json", "vite.config.js", "index.html"]) {
    assert.ok(sent.includes(f), f + " missing from the deployment payload");
  }
});

test("unicode survives the base64 round trip", () => {
  const out = vercelLib.filesToVercel({ "src/x.js": "const s = '→ café ✓';\n" });
  assert.strictEqual(Buffer.from(out[0].data, "base64").toString("utf8"), "const s = '→ café ✓';\n");
});

test("the Vercel provider implements the same contract as VibeSafe hosting", () => {
  assert.strictEqual(vercelLib.vercel.id, "vercel");
  assert.strictEqual(vercelLib.vercel.needsConnection, true);
  for (const fn of ["isAvailable", "status", "deploy"]) {
    assert.strictEqual(typeof vercelLib.vercel[fn], "function", "missing " + fn);
  }
});

test("deploying without a token fails clearly rather than calling the API", async () => {
  await assert.rejects(
    () => vercelLib.vercel.deploy({}, { files: { "a.js": "x" } }),
    /Connect a Vercel token/
  );
});

test("deploying nothing is refused", async () => {
  await assert.rejects(() => vercelLib.vercel.deploy({ vercelToken: "t" }, { files: {} }), /Nothing to deploy/);
});

test("a disconnected account reports not connected", async () => {
  assert.deepStrictEqual(await vercelLib.vercel.status({}), { connected: false });
});

// The token must never reach the browser, so the UI is given a masked hint.
test("the token hint reveals only the ends", () => {
  const h = vercelLib.hint("vcp_abcdefghijklmnop1234");
  assert.ok(h.startsWith("vcp_"));
  assert.ok(h.endsWith("1234"));
  assert.ok(!h.includes("efghijklmn"), "hint leaked the middle of the token");
});

test("vercel credentials are encrypted with a key separate from GitHub's", () => {
  const token = "vcp_secret_value_here";
  const enc = vercelLib.encrypt(token);
  assert.notStrictEqual(enc, token);
  assert.strictEqual(vercelLib.decrypt(enc), token);
  // Domain separation: the GitHub cipher must not be able to read it.
  const gh = require("../lib/github");
  assert.strictEqual(gh.decrypt(enc), null, "a GitHub key decrypted a Vercel credential");
});
