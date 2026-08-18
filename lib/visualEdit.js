// Phase 2B — writing visual-editor changes back into JSX source.
//
// The premise of a visual editor is that clicking an element in the preview and
// changing its colour edits the actual source file, not some parallel style
// store. That requires knowing which JSX element in which file produced a given
// DOM node, and then surgically editing that element's opening tag.
//
// The mapping comes from the runtime in lib/multifile.js: a small Babel plugin
// stamps every HOST element (lowercase tag) with data-vs-loc="file:line:col"
// during the same transform that already handles JSX. So the DOM node carries
// its own source coordinates — no React-internals archaeology, and it works
// against React's production build.
//
// This module does the editing. It is deliberately string-surgery rather than a
// full parse-and-print: reprinting a file through Babel would reformat code the
// user never touched, producing enormous diffs for a one-property change. Here a
// colour tweak changes exactly the characters of that one attribute.

/* ---------------- position helpers ---------------- */

// Babel locations are 1-based line, 0-based column.
function offsetAt(source, line, column) {
  let offset = 0;
  const lines = source.split("\n");
  if (line < 1 || line > lines.length) return -1;
  for (let i = 0; i < line - 1; i++) offset += lines[i].length + 1;
  return offset + column;
}

// Walks forward from the "<" of an opening tag to its ">" or "/>", correctly
// skipping over strings and nested {...} expressions so a ">" inside e.g.
// onClick={() => x > 1} doesn't end the tag early.
function findOpeningTagEnd(source, start) {
  let i = start;
  if (source[i] !== "<") return null;
  i++;
  let depth = 0;
  let quote = null;
  while (i < source.length) {
    const c = source[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
    } else if (c === "{") {
      depth++;
    } else if (c === "}") {
      depth--;
    } else if (c === ">" && depth === 0) {
      const selfClosing = source[i - 1] === "/";
      return { end: i, selfClosing, tagEndIndex: selfClosing ? i - 1 : i };
    }
    i++;
  }
  return null;
}

function tagNameAt(source, start) {
  const m = /^<\s*([A-Za-z][A-Za-z0-9._-]*)/.exec(source.slice(start, start + 200));
  return m ? m[1] : null;
}

/* ---------------- style editing ---------------- */

// camelCase is what JSX expects; the UI works in the same vocabulary.
function styleEntriesToSource(entries) {
  return entries.map(([k, v]) => `${k}: ${JSON.stringify(String(v))}`).join(", ");
}

// Finds an existing style={{ ... }} inside an opening tag and returns its span,
// or null. Only the double-brace object form is handled — style={someVar} is an
// expression we must not rewrite, and is reported as unsupported instead.
function findStyleProp(tagText) {
  const m = /\bstyle\s*=\s*\{\{/.exec(tagText);
  if (!m) return null;
  const openIdx = m.index + m[0].length; // just after "{{"
  let depth = 2; // we are inside two braces
  let i = openIdx;
  let quote = null;
  while (i < tagText.length) {
    const c = tagText[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return { start: m.index, end: i + 1, innerStart: openIdx, innerEnd: i - 1 };
    }
    i++;
  }
  return null;
}

// Removes simple `key: "literal"` pairs for keys we are about to set, so
// repeated edits to the same property don't accumulate. Anything that isn't a
// plain string literal (an expression, a spread, a conditional) is left exactly
// as written — we append our overrides after it, and JS object semantics mean
// the later key wins.
function stripKeys(inner, keys) {
  let out = inner;
  for (const k of keys) {
    const re = new RegExp("(^|,)\\s*" + k + "\\s*:\\s*(\"[^\"]*\"|'[^']*'|`[^`]*`)\\s*(?=,|$)", "g");
    out = out.replace(re, (match, lead) => (lead === "," ? "," : ""));
  }
  return out.replace(/^\s*,\s*/, "").replace(/\s*,\s*$/, "").trim();
}

// Applies style changes to one JSX element identified by a source location.
// Returns { files, error } — never throws, so a bad location can't take down the
// editor.
function applyStyleEdit(files, loc, styles) {
  const parsed = parseLoc(loc);
  if (!parsed) return { error: "Bad element location." };
  const { file, line, column } = parsed;
  const source = files[file];
  if (typeof source !== "string") return { error: "File not found: " + file };

  const start = offsetAt(source, line, column);
  if (start < 0 || source[start] !== "<") return { error: "Could not locate that element in " + file + "." };
  const range = findOpeningTagEnd(source, start);
  if (!range) return { error: "Could not parse that element's tag in " + file + "." };

  const tagText = source.slice(start, range.end + 1);
  if (/\bstyle\s*=\s*\{(?!\{)/.test(tagText)) {
    return { error: "That element's style comes from a variable, so it can't be edited visually yet." };
  }

  const keys = Object.keys(styles);
  if (!keys.length) return { files };
  const additions = styleEntriesToSource(Object.entries(styles));

  const existing = findStyleProp(tagText);
  let newTagText;
  if (existing) {
    const inner = tagText.slice(existing.start + tagText.slice(existing.start).indexOf("{{") + 2, existing.end - 2);
    const kept = stripKeys(inner, keys);
    const merged = kept ? kept + ", " + additions : additions;
    newTagText = tagText.slice(0, existing.start) + "style={{ " + merged + " }}" + tagText.slice(existing.end);
  } else {
    // Insert before the closing ">" (or "/>"), preserving self-closing form.
    const insertAt = range.tagEndIndex - start;
    const needsSpace = !/\s$/.test(tagText.slice(0, insertAt));
    newTagText =
      tagText.slice(0, insertAt) + (needsSpace ? " " : "") + "style={{ " + additions + " }}" + tagText.slice(insertAt);
  }

  return { files: { ...files, [file]: source.slice(0, start) + newTagText + source.slice(range.end + 1) } };
}

/* ---------------- text editing ---------------- */

// Replaces an element's text content. Only handles elements whose children are
// plain text — anything containing nested elements or {expressions} is refused
// rather than risking destroying real code.
function applyTextEdit(files, loc, newText) {
  const parsed = parseLoc(loc);
  if (!parsed) return { error: "Bad element location." };
  const { file, line, column } = parsed;
  const source = files[file];
  if (typeof source !== "string") return { error: "File not found: " + file };

  const start = offsetAt(source, line, column);
  if (start < 0 || source[start] !== "<") return { error: "Could not locate that element in " + file + "." };
  const tag = tagNameAt(source, start);
  const range = findOpeningTagEnd(source, start);
  if (!tag || !range) return { error: "Could not parse that element in " + file + "." };
  if (range.selfClosing) return { error: "That element has no text to edit." };

  const contentStart = range.end + 1;
  const closing = "</" + tag + ">";
  const contentEnd = source.indexOf(closing, contentStart);
  if (contentEnd < 0) return { error: "Could not find the closing tag for <" + tag + ">." };

  const current = source.slice(contentStart, contentEnd);
  if (/[<{]/.test(current)) {
    return { error: "That element contains nested elements or code, so its text can't be edited directly." };
  }

  // Preserve the surrounding whitespace/indentation the author wrote.
  const lead = (current.match(/^\s*/) || [""])[0];
  const trail = (current.match(/\s*$/) || [""])[0];
  const safe = String(newText).replace(/[<>{}]/g, "");
  return {
    files: { ...files, [file]: source.slice(0, contentStart) + lead + safe + trail + source.slice(contentEnd) },
  };
}

/* ---------------- shared ---------------- */

// "src/App.jsx:12:4" — the format the runtime stamps onto data-vs-loc.
function parseLoc(loc) {
  if (typeof loc !== "string") return null;
  const m = /^(.+):(\d+):(\d+)$/.exec(loc.trim());
  if (!m) return null;
  // Babel normalises the filename it is handed into an absolute-looking path, so
  // the runtime stamps "/src/App.jsx" while the project keys files as
  // "src/App.jsx". Strip the leading slash so the two line up.
  return { file: m[1].replace(/^\/+/, ""), line: parseInt(m[2], 10), column: parseInt(m[3], 10) };
}

module.exports = {
  applyStyleEdit,
  applyTextEdit,
  parseLoc,
  offsetAt,
  findOpeningTagEnd,
};
