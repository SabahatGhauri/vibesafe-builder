// Offline unit tests for the Phase 2A multi-file engine. No credentials, no
// network — the assembler and parser are pure functions by design.

const { test } = require("node:test");
const assert = require("node:assert");

const {
  parseMultiFileResponse,
  applyFileChanges,
  validateFiles,
  assembleProject,
  concatSources,
  findEntry,
  normalizePath,
} = require("../lib/multifile");

const APP = {
  "src/main.jsx":
    'import React from "react";\nimport ReactDOM from "react-dom/client";\nimport App from "./App.jsx";\nReactDOM.createRoot(document.getElementById("root")).render(<App />);\n',
  "src/App.jsx": 'import Header from "./components/Header.jsx";\nexport default function App(){ return <Header/>; }\n',
  "src/components/Header.jsx": "export default function Header(){ return <h1>hi</h1>; }\n",
  "src/styles.css": "body{color:red}\n",
};

/* ---------------- parsing ---------------- */

test("parses several FILE blocks out of one response", () => {
  const { files, note } = parseMultiFileResponse(
    "Added a header component.\n\n" +
      "FILE: src/App.jsx\n```jsx\nexport default function App(){}\n```\n\n" +
      "FILE: src/components/Header.jsx\n```jsx\nexport default function Header(){}\n```\n"
  );
  assert.deepStrictEqual(Object.keys(files).sort(), ["src/App.jsx", "src/components/Header.jsx"]);
  assert.strictEqual(note, "Added a header component.");
  assert.match(files["src/App.jsx"], /export default function App/);
});

test("leading ./ and / are stripped from paths", () => {
  const { files } = parseMultiFileResponse("x\nFILE: ./src/a.js\n```js\nconst a=1;\n```\n");
  assert.ok(files["src/a.js"]);
});

test("path traversal is rejected", () => {
  assert.strictEqual(normalizePath("../../etc/passwd"), null);
  assert.strictEqual(normalizePath("src/../../../secrets"), null);
  const { files } = parseMultiFileResponse("x\nFILE: ../escape.js\n```js\nbad\n```\n");
  assert.deepStrictEqual(Object.keys(files), []);
});

/* ---------------- merging ---------------- */

test("only the returned files change; the rest are preserved", () => {
  const next = applyFileChanges(APP, { "src/App.jsx": "changed\n" });
  assert.strictEqual(next["src/App.jsx"], "changed\n");
  assert.strictEqual(next["src/components/Header.jsx"], APP["src/components/Header.jsx"]);
  assert.strictEqual(Object.keys(next).length, Object.keys(APP).length);
});

test("DELETE_FILE removes a file", () => {
  const next = applyFileChanges(APP, { "src/styles.css": "DELETE_FILE" });
  assert.ok(!("src/styles.css" in next));
  assert.strictEqual(Object.keys(next).length, Object.keys(APP).length - 1);
});

test("applyFileChanges does not mutate the previous file set", () => {
  const before = Object.keys(APP).length;
  applyFileChanges(APP, { "src/new.js": "x\n", "src/styles.css": "DELETE_FILE" });
  assert.strictEqual(Object.keys(APP).length, before);
});

/* ---------------- validation ---------------- */

test("a well-formed project validates clean", () => {
  assert.deepStrictEqual(validateFiles(APP), []);
});

test("a project with no entry file is rejected", () => {
  assert.ok(validateFiles({ "src/thing.js": "x" }).some((e) => /entry file/i.test(e)));
});

test("an oversized file is rejected", () => {
  const errs = validateFiles({ ...APP, "src/big.js": "x".repeat(200 * 1024) });
  assert.ok(errs.some((e) => /too large/i.test(e)));
});

test("entry detection prefers src/main.jsx", () => {
  assert.strictEqual(findEntry(APP), "src/main.jsx");
  assert.strictEqual(findEntry({ "src/App.jsx": "x" }), "src/App.jsx");
});

/* ---------------- assembly ---------------- */

test("assembles a single self-contained HTML document", () => {
  const html = assembleProject(APP, { title: "My App" });
  assert.match(html, /^<!DOCTYPE html>/);
  assert.ok(html.includes("__VS_SOURCES__"));
  assert.ok(html.includes('__VS_ENTRY__ = "src/main.jsx"'));
  assert.ok(html.includes("<title>My App</title>"));
});

test("every non-CSS source survives assembly intact", () => {
  const html = assembleProject(APP, {});
  const raw = html.match(/window\.__VS_SOURCES__ = (.*);/)[1];
  const parsed = JSON.parse(raw.split("\\u003c").join("<"));
  for (const p of ["src/main.jsx", "src/App.jsx", "src/components/Header.jsx"]) {
    assert.strictEqual(parsed[p], APP[p], p + " was corrupted during assembly");
  }
});

test("CSS is hoisted into <style> and kept out of the module sources", () => {
  const html = assembleProject(APP, {});
  assert.ok(html.includes("body{color:red}"));
  const raw = html.match(/window\.__VS_SOURCES__ = (.*);/)[1];
  const parsed = JSON.parse(raw.split("\\u003c").join("<"));
  assert.ok(!("src/styles.css" in parsed), "css should not be a runtime module");
});

// Regression: an earlier version escaped nothing (the replacement resolved to a
// no-op), so a source file containing </script> closed the tag and broke out.
test("a source file containing </script> cannot break out of the script tag", () => {
  const html = assembleProject(
    { ...APP, "src/evil.js": '// </script><script>alert(1)</script>\nexport const x = 1;\n' },
    {}
  );
  assert.ok(!html.includes("</script><script>alert(1)"), "script breakout not neutralised");
});

test("the title is HTML-escaped", () => {
  const html = assembleProject(APP, { title: 'Bad & <script>"x"' });
  assert.ok(html.includes("<title>Bad &amp; &lt;script&gt;&quot;x&quot;</title>"));
  assert.ok(!html.includes("<title>Bad & <script>"));
});

test("index.html supplies the title when present", () => {
  const html = assembleProject({ ...APP, "index.html": "<html><head><title>From Index</title></head></html>" }, {});
  assert.ok(html.includes("<title>From Index</title>"));
});

test("assembling without an entry file throws", () => {
  assert.throws(() => assembleProject({ "src/thing.js": "x" }, {}), /entry file/i);
});

/* ---------------- security scanning input ---------------- */

// The security scan must see what the MODEL wrote, not the assembled bundle
// (which contains our own new Function loader and would false-positive).
test("concatSources includes every file's contents and its path", () => {
  const all = concatSources(APP);
  for (const p of Object.keys(APP)) assert.ok(all.includes(p), p + " missing from scan input");
  assert.ok(all.includes("export default function Header"));
});

test("concatSources output does not contain the runtime loader", () => {
  const all = concatSources(APP);
  assert.ok(!all.includes("new Function"), "scan input must not include our loader");
});

/* ---------------- the runtime itself ---------------- */

// Regression, and an important one: the runtime ships as a STRING inside this
// module, so a syntax error in it is invisible to `node --check` on the file and
// to every other test here — the module loads fine, assembly "succeeds", and the
// breakage only appears as a blank preview in a browser. This happened: an
// escaping slip turned /^\/+/ into /^/+/, an invalid regex, which killed the
// whole IIFE and left the preview silently empty.
test("the browser runtime embedded in the assembled page is valid JavaScript", () => {
  const html = assembleProject(APP, {});
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 2, "expected inline runtime scripts");
  for (const src of scripts) {
    assert.doesNotThrow(() => new Function(src), "inline runtime script is not parseable:\n" + src.slice(0, 300));
  }
});

test("the runtime's error-reporting helpers survive escaping", () => {
  const html = assembleProject(APP, {});
  const BS = String.fromCharCode(92); // a literal backslash, built by code point
  // These regexes are the ones an escaping slip silently destroys.
  assert.ok(html.includes("function fileFromMessage"), "fileFromMessage missing");
  assert.ok(html.includes("(?:in|not found:)"+BS+"s+"), "fileFromMessage regex lost its escapes");
  assert.ok(html.includes('report("build-ok"'), "build-ok reporting missing");
  assert.ok(html.includes('report("build-error"'), "build-error reporting missing");
});

/* ---------------- project scaffold (real Vite project) ---------------- */

const { scaffold, withScaffold, hasScaffold, isRuntimeModule, SCAFFOLD_FILES } = require("../lib/multifile");

test("scaffold produces a runnable Vite project", () => {
  const s = scaffold("my-app");
  const pkg = JSON.parse(s["package.json"]);
  assert.strictEqual(pkg.name, "my-app");
  assert.strictEqual(pkg.type, "module");
  assert.ok(pkg.scripts.dev && pkg.scripts.build, "missing dev/build scripts");
  assert.ok(pkg.dependencies.react && pkg.dependencies["react-dom"], "react not declared as a dependency");
  assert.ok(pkg.devDependencies.vite, "vite not declared");
  assert.match(s["vite.config.js"], /@vitejs\/plugin-react/);
  // Vite needs index.html to point at the real entry module.
  assert.match(s["index.html"], /<script type="module" src="\/src\/main\.jsx"><\/script>/);
  assert.match(s["index.html"], /<div id="root">/);
});

test("project names are slugified into a valid package name", () => {
  assert.strictEqual(JSON.parse(scaffold("Pricing Calculator!")["package.json"]).name, "pricing-calculator");
  assert.strictEqual(JSON.parse(scaffold("")["package.json"]).name, "vibesafe-app");
  assert.strictEqual(JSON.parse(scaffold("  ***  ")["package.json"]).name, "vibesafe-app");
});

test("withScaffold adds every missing file", () => {
  const out = withScaffold({ "src/main.jsx": "x\n" });
  for (const f of SCAFFOLD_FILES) assert.ok(f in out, f + " missing");
  assert.strictEqual(out["src/main.jsx"], "x\n", "existing file was disturbed");
});

test("withScaffold never overwrites a file the user already edited", () => {
  const mine = '{ "name": "mine" }\n';
  const out = withScaffold({ "src/main.jsx": "x\n", "package.json": mine });
  assert.strictEqual(out["package.json"], mine);
});

test("hasScaffold detects a complete project", () => {
  assert.strictEqual(hasScaffold({ "src/main.jsx": "x" }), false);
  assert.strictEqual(hasScaffold(withScaffold({ "src/main.jsx": "x" })), true);
});

test("scaffold files are not treated as runtime modules", () => {
  for (const f of SCAFFOLD_FILES) assert.strictEqual(isRuntimeModule(f), false, f + " should not be a runtime module");
  assert.strictEqual(isRuntimeModule("src/App.jsx"), true);
  assert.strictEqual(isRuntimeModule("src/utils/x.js"), true);
  assert.strictEqual(isRuntimeModule("src/styles.css"), false);
});

// The preview runtime must keep working unchanged now that the project also
// contains build files — package.json is not JavaScript and would blow up if
// Babel tried to transform it as a module.
test("assembly excludes scaffold from the runtime module map", () => {
  const html = assembleProject(withScaffold(APP), {});
  const raw = html.match(/window\.__VS_SOURCES__ = (.*);/)[1];
  const sources = JSON.parse(raw.split("\u003c").join("<"));
  for (const f of SCAFFOLD_FILES) assert.ok(!(f in sources), f + " leaked into the runtime module map");
  assert.ok("src/App.jsx" in sources);
  assert.ok("src/main.jsx" in sources);
});

test("a scaffolded project still validates and assembles", () => {
  const files = withScaffold(APP);
  assert.deepStrictEqual(validateFiles(files), []);
  assert.match(assembleProject(files, {}), /^<!DOCTYPE html>/);
});
