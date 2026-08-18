// Phase 2A — multi-file project engine.
//
// Single-file apps (Phase 1) stay exactly as they were: one HTML document, one
// version, one string. This module adds a SECOND project kind alongside it — a
// real file tree the AI can edit several files of in one request — without
// touching any of the single-file path.
//
// The awkward constraint: VibeSafe has no build server. Generated apps are
// static, and published apps are one HTML row served verbatim. So rather than
// bundling server-side (a whole toolchain, cold starts, and node_modules in a
// serverless function), assembleProject() emits a self-contained HTML document
// carrying every source file as a string plus a ~40-line CommonJS-style module
// runtime. Babel-standalone transforms JSX and ES modules in the browser at
// load time. That's the same approach in-browser playgrounds use, it needs no
// build step at all, and the output is still ONE html string — so publishing,
// the /p/:id route, PWA injection and the Phase 1a/1b backend all keep working
// with zero changes.
//
// Deliberate limits: dependencies come from a CDN allowlist (no npm install),
// and only React is wired up as a bare specifier today. TypeScript, CSS
// preprocessors and arbitrary npm packages are explicitly out of scope here.

const MAX_FILES = 40;
const MAX_FILE_BYTES = 100 * 1024;
const MAX_TOTAL_BYTES = 600 * 1024;
const PATH_RE = /^[a-zA-Z0-9._/-]{1,120}$/;

// Bare specifiers a generated project may import. Everything else must be a
// relative path to another project file — keeps the dependency surface (and the
// CSP allowlist the published-app route already enforces) closed and known.
const BARE_MODULES = {
  react: "React",
  "react-dom": "ReactDOM",
  "react-dom/client": "ReactDOM",
};

const CDN = {
  react: "https://unpkg.com/react@18/umd/react.production.min.js",
  reactDom: "https://unpkg.com/react-dom@18/umd/react-dom.production.min.js",
  babel: "https://unpkg.com/@babel/standalone@7/babel.min.js",
};

/* ---------------- parsing the model's response ---------------- */

// The model is asked (see MULTIFILE_PROMPT in lib/app.js) to emit one fenced
// block per file, each preceded by a `FILE: path` line. Anything outside those
// blocks is prose and becomes the chat note.
function parseMultiFileResponse(text) {
  const files = {};
  const re = /FILE:\s*([^\n`]+)\n+```[a-zA-Z]*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const path = normalizePath(m[1]);
    if (path) files[path] = m[2].replace(/\s+$/, "") + "\n";
  }
  const note = (text.split(/FILE:/)[0] || "").trim().split("\n").filter(Boolean)[0] || "Updated the project.";
  return { files, note };
}

function normalizePath(raw) {
  let p = String(raw).trim().replace(/^\.\//, "").replace(/^\/+/, "");
  if (!p || !PATH_RE.test(p)) return null;
  if (p.includes("..")) return null; // no traversal out of the project
  return p;
}

// Applies a generation's files onto the previous file set. The model returns
// only the files it changed, so this is a merge, not a replace — that's what
// makes "change 4 files out of 12" cost 4 files of output instead of 12.
// A file whose body is exactly DELETE_FILE is removed.
function applyFileChanges(previous, changes) {
  const next = { ...previous };
  for (const [path, content] of Object.entries(changes)) {
    if (content.trim() === "DELETE_FILE") delete next[path];
    else next[path] = content;
  }
  return next;
}

function validateFiles(files) {
  const errors = [];
  const paths = Object.keys(files);
  if (paths.length === 0) errors.push("The project has no files.");
  if (paths.length > MAX_FILES) errors.push(`Too many files (${paths.length}) — the limit is ${MAX_FILES}.`);
  let total = 0;
  for (const p of paths) {
    if (!PATH_RE.test(p)) errors.push(`Invalid file path: ${p}`);
    const bytes = Buffer.byteLength(files[p], "utf8");
    total += bytes;
    if (bytes > MAX_FILE_BYTES) errors.push(`${p} is too large (${bytes} bytes, limit ${MAX_FILE_BYTES}).`);
  }
  if (total > MAX_TOTAL_BYTES) errors.push(`Project is too large (${total} bytes, limit ${MAX_TOTAL_BYTES}).`);
  if (!findEntry(files)) errors.push("No entry file found — expected src/main.jsx, src/index.jsx, or src/App.jsx.");
  return errors;
}

function findEntry(files) {
  const candidates = ["src/main.jsx", "src/main.js", "src/index.jsx", "src/index.js", "src/App.jsx", "App.jsx", "main.jsx", "index.jsx"];
  return candidates.find((c) => files[c]) || null;
}

/* ---------------- assembly ---------------- */

// Makes a JSON literal safe to embed inside a <script> block. Two hazards: a
// literal "</script>" inside any file would close the tag early, and U+2028/U+2029
// were not legal in JS string literals before ES2019. Escaping "<" covers the
// first; the two separators cover the second.
function jsonForScript(value) {
  // Only real hazard is a literal "</script>" inside a source file closing the
  // tag early; escaping "<" prevents it. U+2028/U+2029 need no special handling —
  // they have been valid in JS string literals since ES2019.
  return JSON.stringify(value).split("<").join("\\u003c");
}

function htmlEscape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// The in-browser module runtime. Kept as a plain string (not a template with
// interpolation) so it's readable as the actual JS that ships. It deliberately
// uses new Function to evaluate transformed modules — that's OUR loader, not
// model-generated code. The security scan runs over the SOURCE files before
// assembly for exactly this reason (see /api/publish in lib/app.js), so an
// eval() written by the model is still caught while the loader itself isn't
// flagged as a false positive.
const RUNTIME = `
(function () {
  var SOURCES = window.__VS_SOURCES__, ENTRY = window.__VS_ENTRY__;
  var BARE = { "react": window.React, "react-dom": window.ReactDOM, "react-dom/client": window.ReactDOM };
  var cache = {};
  var EXT = ["", ".jsx", ".js", "/index.jsx", "/index.js"];

  function resolve(fromPath, spec) {
    if (spec.charAt(0) !== ".") return null;
    var base = fromPath.split("/").slice(0, -1);
    var parts = spec.split("/");
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] === "." || parts[i] === "") continue;
      if (parts[i] === "..") base.pop();
      else base.push(parts[i]);
    }
    var joined = base.join("/");
    for (var j = 0; j < EXT.length; j++) {
      if (Object.prototype.hasOwnProperty.call(SOURCES, joined + EXT[j])) return joined + EXT[j];
    }
    return joined;
  }

  function req(fromPath, spec) {
    if (Object.prototype.hasOwnProperty.call(BARE, spec)) {
      var g = BARE[spec];
      if (!g) throw new Error("Dependency '" + spec + "' is not available.");
      return g;
    }
    var target = resolve(fromPath, spec);
    if (target === null) throw new Error("Cannot import '" + spec + "' — only React and relative paths are supported.");
    if (/\\.css$/.test(target)) return {};
    if (!Object.prototype.hasOwnProperty.call(SOURCES, target)) {
      throw new Error("File not found: " + target + " (imported from " + fromPath + ")");
    }
    return load(target);
  }

  function load(path) {
    if (cache[path]) return cache[path].exports;
    var mod = { exports: {} };
    cache[path] = mod;
    var out;
    try {
      out = Babel.transform(SOURCES[path], {
        presets: [["react", { runtime: "classic" }]],
        plugins: ["transform-modules-commonjs"],
        filename: path,
        sourceType: "module"
      }).code;
    } catch (e) {
      throw new Error("Syntax error in " + path + ": " + e.message);
    }
    var fn = new Function("require", "module", "exports", out);
    fn(function (s) { return req(path, s); }, mod, mod.exports);
    return mod.exports;
  }

  try {
    load(ENTRY);
  } catch (e) {
    var box = document.createElement("pre");
    box.style.cssText = "margin:0;padding:16px;font:13px/1.5 ui-monospace,Menlo,Consolas,monospace;color:#ff6b6b;background:#1a1114;white-space:pre-wrap;";
    box.textContent = "Runtime error\\n\\n" + (e && e.message ? e.message : String(e));
    document.body.appendChild(box);
    if (window.parent !== window) {
      try { window.parent.postMessage({ __vibesafe: "runtime-error", message: String(e && e.message || e) }, "*"); } catch (_) {}
    }
  }
})();
`;

// Turns a file map into one self-contained HTML document. Same output shape as
// a single-file app, so every downstream consumer (publish, /p/:id, PWA tags,
// download) treats it identically.
function assembleProject(files, { title } = {}) {
  const entry = findEntry(files);
  if (!entry) throw new Error("No entry file found — expected src/main.jsx, src/index.jsx, or src/App.jsx.");

  // CSS can't go through the module runtime, so it's hoisted into a <style>.
  // Imports of .css files become no-ops in req() above.
  const css = Object.keys(files)
    .filter((p) => p.endsWith(".css"))
    .sort()
    .map((p) => `/* ${p} */\n${files[p]}`)
    .join("\n");

  const sources = {};
  for (const [p, c] of Object.entries(files)) {
    if (!p.endsWith(".css")) sources[p] = c;
  }

  // A project-supplied index.html is used only for its <title>; the document
  // shell is ours, because it has to carry the runtime and CDN scripts.
  let docTitle = title || "My App";
  if (files["index.html"]) {
    const m = files["index.html"].match(/<title>([^<]*)<\/title>/i);
    if (m && m[1].trim()) docTitle = m[1].trim();
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${htmlEscape(docTitle)}</title>
<script src="${CDN.react}"></script>
<script src="${CDN.reactDom}"></script>
<script src="${CDN.babel}"></script>
<style>
html,body{margin:0;padding:0}
${css}
</style>
</head>
<body>
<div id="root"></div>
<script>
window.__VS_SOURCES__ = ${jsonForScript(sources)};
window.__VS_ENTRY__ = ${jsonForScript(entry)};
</script>
<script>${RUNTIME}</script>
</body>
</html>
`;
}

// Security scanning must see what the model wrote, not the assembled bundle
// (which contains our own new Function loader). This is what /api/publish and
// the client-side scanner run over for multi-file projects.
function concatSources(files) {
  return Object.keys(files)
    .sort()
    .map((p) => `/* ${p} */\n${files[p]}`)
    .join("\n\n");
}

module.exports = {
  parseMultiFileResponse,
  applyFileChanges,
  validateFiles,
  assembleProject,
  concatSources,
  findEntry,
  normalizePath,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
};
