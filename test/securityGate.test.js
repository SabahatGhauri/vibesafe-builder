// The Launch Check security gate.
//
// Two failure modes matter here and they pull in opposite directions:
// letting a live credential reach a public site, and crying wolf often enough
// that people override by reflex. Both are tested.

const { test } = require("node:test");
const assert = require("node:assert");

const { scanProject, gateDecision, auditSummary, mask } = require("../lib/securityGate");

const CLEAN = {
  "package.json": '{"name":"my-app","dependencies":{"react":"^18.0.0"}}',
  "src/App.jsx":
    'import React, { useState } from "react";\n' +
    'export default function App() {\n' +
    "  const [todos, setTodos] = useState([]);\n" +
    '  localStorage.setItem("todos", JSON.stringify(todos));\n' +
    "  return <h1>Todos</h1>;\n}\n",
  "README.md": "# My App\n\nRun `npm install` then `npm run dev`.\n",
};

const find = (scan, rule) => scan.findings.find((f) => f.rule === rule);

/* ---------------- 1. a clean project is allowed ---------------- */

test("a clean project passes and is allowed", () => {
  const scan = scanProject(CLEAN);
  assert.strictEqual(scan.verdict, "clean", JSON.stringify(scan.findings));
  assert.strictEqual(scan.counts.critical, 0);
  assert.strictEqual(gateDecision(scan).allowed, true);
});

test("ordinary localStorage use is not flagged", () => {
  const scan = scanProject({ "src/a.js": 'localStorage.setItem("todos", JSON.stringify(t));' });
  assert.strictEqual(scan.counts.critical, 0);
  assert.strictEqual(scan.counts.high, 0);
});

/* ---------------- 2. a hardcoded API key blocks ---------------- */

test("a hardcoded API key blocks deployment", () => {
  const scan = scanProject({
    ...CLEAN,
    "src/api.js": 'const key = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";\nexport default key;\n',
  });
  assert.strictEqual(scan.verdict, "blocked");
  const d = gateDecision(scan);
  assert.strictEqual(d.allowed, false);
  assert.strictEqual(d.overridable, false, "a live credential must NOT be overridable");
});

test("credentials from several providers are all caught", () => {
  const cases = {
    "a.js": 'const k = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";',
    "b.js": 'const k = "AKIA2QW7ZXCVBNM4LKJH";',
    "c.js": 'const k = "AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe";',
    "d.js": 'const k = "ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";',
    "e.js": 'const k = "sk_live_AbCdEfGhIjKlMnOpQrStUv";',
    "f.js": 'const k = "xoxb-123456789012-abcdefghijkl";',
    "g.js": "const k = `-----BEGIN RSA PRIVATE KEY-----`;",
    "h.js": 'const u = "postgres://admin:hunter2@db.example.com:5432/app";',
  };
  for (const [file, content] of Object.entries(cases)) {
    const scan = scanProject({ [file]: content });
    assert.strictEqual(scan.counts.critical >= 1, true, `${file} was not flagged: ${content}`);
  }
});

/* ---------------- 3. a secret in a nested file blocks ---------------- */

test("a secret in a deeply nested file is found", () => {
  const scan = scanProject({
    ...CLEAN,
    "src/lib/internal/helpers/config.js": 'export const STRIPE = "sk_live_AbCdEfGhIjKlMnOpQrStUv";\n',
  });
  assert.strictEqual(scan.verdict, "blocked");
  const f = scan.findings.find((x) => x.severity === "critical");
  assert.strictEqual(f.file, "src/lib/internal/helpers/config.js");
  assert.strictEqual(f.line, 1);
});

test("a finding reports the exact line in a multi-line file", () => {
  const scan = scanProject({
    "src/x.js": "const a = 1;\nconst b = 2;\n// notes\nconst key = \"sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz01234\";\n",
  });
  const f = scan.findings.find((x) => x.severity === "critical");
  assert.strictEqual(f.line, 4, "wrong line reported — a finding the user cannot locate is not actionable");
});

/* ---------------- 4. env / config files ---------------- */

test("a secret in a .env file is detected", () => {
  const scan = scanProject({
    ...CLEAN,
    ".env": "NODE_ENV=production\nDATABASE_PASSWORD=Xk9$mQ2vLp8ZrT4wYs6N\n",
  });
  assert.strictEqual(scan.verdict, "blocked");
  assert.ok(find(scan, "secret-in-config"), "config secret not detected");
});

test("a secret in a JSON config file is detected", () => {
  const scan = scanProject({
    "config/prod.json": '{\n  "apiKey": "Xk9mQ2vLp8ZrT4wYs6NbG3hJ5kL7pQ1s"\n}\n',
  });
  assert.strictEqual(scan.counts.critical >= 1, true);
});

test("a committed .env file is flagged even when its values look harmless", () => {
  const scan = scanProject({ ...CLEAN, ".env": "PORT=3000\n" });
  assert.ok(find(scan, "env-file-deployed"), "a deployed .env should be surfaced");
  assert.strictEqual(scan.counts.critical, 0, "but harmless values must not block");
});

/* ---------------- 5. false positives ---------------- */

test("placeholder values in documentation do not block", () => {
  const scan = scanProject({
    ...CLEAN,
    "README.md":
      "# Setup\n\n" +
      "Set `API_KEY=your-api-key-here` in `.env`.\n\n" +
      '```js\nconst apiKey = "YOUR_API_KEY";\nconst secret = "changeme";\n```\n',
  });
  assert.strictEqual(scan.verdict, "clean", JSON.stringify(scan.findings));
});

test("an example env file with placeholders does not block", () => {
  const scan = scanProject({
    ...CLEAN,
    ".env.example": "DATABASE_PASSWORD=your-password-here\nAPI_KEY=<your key>\nSECRET_TOKEN=changeme\n",
  });
  assert.strictEqual(scan.verdict, "clean", JSON.stringify(scan.findings));
});

test("environment variable references are not treated as secrets", () => {
  const scan = scanProject({
    "src/a.js":
      'const key = process.env.API_KEY;\n' +
      "const b = import.meta.env.VITE_TOKEN;\n" +
      'const c = `${process.env.SECRET}`;\n',
    ".env.production": "API_KEY=${API_KEY}\n",
  });
  assert.strictEqual(scan.counts.critical, 0, JSON.stringify(scan.findings));
});

test("prose about eval is not eval", () => {
  const scan = scanProject({ "docs/security.md": "Never use eval() in your code. new Function() is equally unsafe.\n" });
  assert.strictEqual(scan.counts.high, 0);
});

test("short or low-entropy values are not treated as credentials", () => {
  const scan = scanProject({
    "src/a.js": 'const password = "hello";\nconst token = "abc";\nconst secret = "";\nconst apiKey = "lowercase";',
  });
  assert.strictEqual(scan.counts.critical, 0, JSON.stringify(scan.findings));
});

// A credential-shaped value in documentation is usually a teaching example, so
// it must not hard-block — but it is still worth saying out loud, because
// sometimes it is a real key someone pasted into their README.
test("a credential-shaped value in a README is mentioned but does not block", () => {
  const scan = scanProject({
    "README.md": '```js\nconst apiKey = "Xk9mQ2vLp8ZrT4wYs6NbG3hJ5kL7pQ1s";\n```\n',
  });
  assert.strictEqual(scan.counts.critical, 0, "documentation should not hard-block");
  assert.strictEqual(scan.counts.info >= 1, true, "but it should still be mentioned");
});

/* ---------------- severity model ---------------- */

test("high-severity issues block but CAN be overridden", () => {
  const scan = scanProject({ ...CLEAN, "src/bad.js": 'eval(userInput);\n' });
  assert.strictEqual(scan.verdict, "override_required");
  assert.strictEqual(gateDecision(scan).allowed, false);
  assert.strictEqual(gateDecision(scan).overridable, true);
  assert.strictEqual(gateDecision(scan, { override: true }).allowed, true);
});

// The rule that matters most in the whole file.
test("an override CANNOT bypass a critical finding", () => {
  const scan = scanProject({ "src/a.js": 'const k = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz01234";' });
  const d = gateDecision(scan, { override: true });
  assert.strictEqual(d.allowed, false, "a live credential was published because someone passed override");
  assert.strictEqual(d.overridable, false);
});

test("medium issues warn but never block", () => {
  const scan = scanProject({ ...CLEAN, ".env": "PORT=3000\n" });
  assert.strictEqual(scan.verdict, "warn");
  assert.strictEqual(gateDecision(scan).allowed, true);
});

test("informational findings never block", () => {
  const scan = scanProject({ ...CLEAN, "src/api.js": 'res.setHeader("Access-Control-Allow-Origin", "*");' });
  assert.strictEqual(gateDecision(scan).allowed, true);
});

test("findings are ordered worst first", () => {
  const scan = scanProject({
    "src/a.js": 'res.setHeader("Access-Control-Allow-Origin", "*");\neval(x);\nconst k = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz01234";',
  });
  assert.strictEqual(scan.findings[0].severity, "critical");
});

/* ---------------- the code is never modified, the secret never echoed ---------------- */

test("scanning does not modify the project", () => {
  const files = { "src/a.js": 'const k = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz01234";' };
  const before = JSON.stringify(files);
  scanProject(files);
  assert.strictEqual(JSON.stringify(files), before, "the scanner rewrote the user's code");
});

// A scanner that copies credentials into audit logs and HTTP responses has made
// the leak worse, not better.
test("the secret itself is never echoed back in a finding", () => {
  const SECRET = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  const scan = scanProject({ "src/a.js": `const k = "${SECRET}";` });
  assert.ok(!JSON.stringify(scan).includes(SECRET), "the scan result leaked the secret");
  const f = scan.findings[0];
  assert.ok(f.snippet.includes("•"), "the snippet should be masked: " + f.snippet);
});

test("the audit summary carries locations but no snippets", () => {
  const SECRET = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
  const summary = auditSummary(scanProject({ "src/a.js": `const k = "${SECRET}";` }));
  assert.ok(!JSON.stringify(summary).includes(SECRET));
  assert.ok(!JSON.stringify(summary).includes("snippet"));
  assert.strictEqual(summary.findings[0].file, "src/a.js");
  assert.strictEqual(summary.verdict, "blocked");
});

test("masking never reveals the middle of a value", () => {
  assert.ok(!mask("sk-ant-supersecretvalue1234").includes("supersecret"));
});

/* ---------------- robustness ---------------- */

test("an empty project is clean, not an error", () => {
  assert.strictEqual(scanProject({}).verdict, "clean");
  assert.strictEqual(scanProject(null).verdict, "clean");
});

test("non-string file contents are skipped rather than crashing", () => {
  const scan = scanProject({ "a.js": null, "b.js": 42, "c.js": 'const k = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz01234";' });
  assert.strictEqual(scan.counts.critical, 1);
});

test("every finding carries a file, a line and a remediation", () => {
  const scan = scanProject({
    "src/a.js": 'const k = "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz01234";\neval(x);',
    ".env": "SECRET_KEY=Xk9$mQ2vLp8ZrT4wYs6N\n",
  });
  for (const f of scan.findings) {
    assert.ok(f.file, "finding without a file");
    assert.ok(typeof f.line === "number", "finding without a line: " + f.rule);
    assert.ok(f.remediation, "finding without remediation: " + f.rule);
    assert.ok(f.label, "finding without a label: " + f.rule);
  }
});
