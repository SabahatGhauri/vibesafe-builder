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

test("a hardcoded secret is blocked", () => {
  const blockers = scanBlockers('const key = "sk-ant-abcdefghijklmnopqrstuvwxyz123456";');
  assert.ok(blockers.some((b) => /secret/i.test(b)));
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
