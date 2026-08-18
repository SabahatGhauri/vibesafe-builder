// Offline unit tests for the Phase 2B visual-edit engine — the part that writes
// changes back into real JSX source. No browser, no credentials.

const { test } = require("node:test");
const assert = require("node:assert");
const { applyStyleEdit, applyTextEdit, parseLoc, offsetAt } = require("../lib/visualEdit");

// Locations are 1-based line / 0-based column, matching Babel.
function loc(line, col, file = "src/App.jsx") {
  return `${file}:${line}:${col}`;
}

/* ---------------- location parsing ---------------- */

test("parses a location string", () => {
  assert.deepStrictEqual(parseLoc("src/App.jsx:12:4"), { file: "src/App.jsx", line: 12, column: 4 });
});

// The runtime stamps a Babel-normalised filename, which gains a leading slash.
test("strips the leading slash Babel adds to filenames", () => {
  assert.deepStrictEqual(parseLoc("/src/App.jsx:3:9"), { file: "src/App.jsx", line: 3, column: 9 });
});

test("an edit works with a runtime-style stamped location", () => {
  const files = { "src/App.jsx": "export default function App(){\n  return <h1>Hi</h1>;\n}\n" };
  const { files: out, error } = applyStyleEdit(files, "/src/App.jsx:2:9", { color: "red" });
  assert.strictEqual(error, undefined);
  assert.ok(out["src/App.jsx"].includes('color: "red"'));
});

test("handles paths containing colons gracefully", () => {
  assert.strictEqual(parseLoc("nonsense"), null);
  assert.strictEqual(parseLoc(null), null);
});

test("offsetAt finds the right character", () => {
  const src = "line one\nline two\nline three";
  assert.strictEqual(src[offsetAt(src, 2, 0)], "l");
  assert.strictEqual(src.slice(offsetAt(src, 2, 5), offsetAt(src, 2, 8)), "two");
});

/* ---------------- adding styles ---------------- */

test("adds a style prop to an element that has none", () => {
  const files = { "src/App.jsx": 'export default function App(){\n  return <h1>Hello</h1>;\n}\n' };
  const { files: out, error } = applyStyleEdit(files, loc(2, 9), { color: "red" });
  assert.strictEqual(error, undefined);
  assert.ok(out["src/App.jsx"].includes('<h1 style={{ color: "red" }}>Hello</h1>'), out["src/App.jsx"]);
});

test("preserves existing attributes when adding a style", () => {
  const files = { "src/App.jsx": 'export default function App(){\n  return <h1 className="title">Hi</h1>;\n}\n' };
  const { files: out } = applyStyleEdit(files, loc(2, 9), { color: "blue" });
  assert.ok(out["src/App.jsx"].includes('className="title"'));
  assert.ok(out["src/App.jsx"].includes('color: "blue"'));
});

test("keeps a self-closing element self-closing", () => {
  const files = { "src/App.jsx": "export default function App(){\n  return <img src=\"a.png\" />;\n}\n" };
  const { files: out } = applyStyleEdit(files, loc(2, 9), { width: "100px" });
  const line = out["src/App.jsx"].split("\n")[1];
  assert.ok(line.includes("/>"), line);
  assert.ok(line.includes('width: "100px"'), line);
});

/* ---------------- merging styles ---------------- */

test("merges into an existing style object", () => {
  const files = { "src/App.jsx": 'export default function App(){\n  return <h1 style={{ color: "red" }}>Hi</h1>;\n}\n' };
  const { files: out } = applyStyleEdit(files, loc(2, 9), { fontSize: "20px" });
  const s = out["src/App.jsx"];
  assert.ok(s.includes('color: "red"'), s);
  assert.ok(s.includes('fontSize: "20px"'), s);
});

test("overwriting the same property does not duplicate it", () => {
  const files = { "src/App.jsx": 'export default function App(){\n  return <h1 style={{ color: "red" }}>Hi</h1>;\n}\n' };
  const once = applyStyleEdit(files, loc(2, 9), { color: "blue" }).files;
  const twice = applyStyleEdit(once, loc(2, 9), { color: "green" }).files;
  const s = twice["src/App.jsx"];
  assert.strictEqual((s.match(/color:/g) || []).length, 1, s);
  assert.ok(s.includes('color: "green"'), s);
});

test("expressions inside an existing style object are preserved", () => {
  const files = {
    "src/App.jsx": 'export default function App(){\n  return <h1 style={{ color: theme.fg }}>Hi</h1>;\n}\n',
  };
  const { files: out } = applyStyleEdit(files, loc(2, 9), { fontSize: "14px" });
  const s = out["src/App.jsx"];
  assert.ok(s.includes("color: theme.fg"), "existing expression was destroyed: " + s);
  assert.ok(s.includes('fontSize: "14px"'), s);
});

test("refuses to rewrite a style that comes from a variable", () => {
  const files = { "src/App.jsx": "export default function App(){\n  return <h1 style={styles.title}>Hi</h1>;\n}\n" };
  const { error, files: out } = applyStyleEdit(files, loc(2, 9), { color: "red" });
  assert.match(error, /variable/i);
  assert.strictEqual(out, undefined);
});

/* ---------------- tricky tags ---------------- */

// Regression: a ">" inside a JSX expression must not be mistaken for the end of
// the opening tag.
test("a > inside an expression attribute does not confuse tag parsing", () => {
  const files = {
    "src/App.jsx": "export default function App(){\n  return <button onClick={() => count > 1 && reset()}>Go</button>;\n}\n",
  };
  const { files: out, error } = applyStyleEdit(files, loc(2, 9), { color: "red" });
  assert.strictEqual(error, undefined);
  const s = out["src/App.jsx"];
  assert.ok(s.includes("count > 1 && reset()"), "expression was mangled: " + s);
  assert.ok(s.includes('color: "red"'), s);
  assert.ok(s.includes(">Go</button>"), s);
});

test("a > inside a string attribute does not confuse tag parsing", () => {
  const files = { "src/App.jsx": 'export default function App(){\n  return <h1 title="a > b">Hi</h1>;\n}\n' };
  const { files: out, error } = applyStyleEdit(files, loc(2, 9), { color: "red" });
  assert.strictEqual(error, undefined);
  assert.ok(out["src/App.jsx"].includes('title="a > b"'));
});

/* ---------------- text editing ---------------- */

test("edits plain text content", () => {
  const files = { "src/App.jsx": "export default function App(){\n  return <h1>Old title</h1>;\n}\n" };
  const { files: out, error } = applyTextEdit(files, loc(2, 9), "New title");
  assert.strictEqual(error, undefined);
  assert.ok(out["src/App.jsx"].includes("<h1>New title</h1>"), out["src/App.jsx"]);
});

test("preserves surrounding whitespace when editing text", () => {
  const files = { "src/App.jsx": "export default function App(){\n  return (\n    <h1>\n      Old\n    </h1>\n  );\n}\n" };
  const { files: out } = applyTextEdit(files, loc(3, 4), "New");
  assert.ok(out["src/App.jsx"].includes("\n      New\n    </h1>"), JSON.stringify(out["src/App.jsx"]));
});

test("refuses to edit text of an element containing child elements", () => {
  const files = { "src/App.jsx": "export default function App(){\n  return <div><span>x</span></div>;\n}\n" };
  const { error } = applyTextEdit(files, loc(2, 9), "nope");
  assert.match(error, /nested/i);
});

test("refuses to edit text containing an expression", () => {
  const files = { "src/App.jsx": "export default function App(){\n  return <h1>{title}</h1>;\n}\n" };
  const { error } = applyTextEdit(files, loc(2, 9), "nope");
  assert.match(error, /nested elements or code/i);
});

test("strips characters that would break out of JSX text", () => {
  const files = { "src/App.jsx": "export default function App(){\n  return <h1>Hi</h1>;\n}\n" };
  const { files: out } = applyTextEdit(files, loc(2, 9), "Bad <script> {evil}");
  const s = out["src/App.jsx"];
  assert.ok(!s.includes("<script>"), s);
  assert.ok(!s.includes("{evil}"), s);
});

/* ---------------- failure handling ---------------- */

test("a bad location returns an error rather than throwing", () => {
  const files = { "src/App.jsx": "export default function App(){}\n" };
  assert.match(applyStyleEdit(files, loc(99, 0), { color: "red" }).error, /locate/i);
  assert.match(applyStyleEdit(files, "garbage", { color: "red" }).error, /Bad element location/i);
  assert.match(applyStyleEdit(files, loc(1, 0, "src/Nope.jsx"), { color: "red" }).error, /File not found/i);
});

test("editing one file leaves the others untouched", () => {
  const files = {
    "src/App.jsx": "export default function App(){\n  return <h1>Hi</h1>;\n}\n",
    "src/Other.jsx": "export const x = 1;\n",
  };
  const { files: out } = applyStyleEdit(files, loc(2, 9), { color: "red" });
  assert.strictEqual(out["src/Other.jsx"], files["src/Other.jsx"]);
});
