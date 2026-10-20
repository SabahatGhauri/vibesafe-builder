// Small, dependency-free CSS minifier for the landing page's inline <style> blocks.
//
// The source keeps its comments (they explain choices like the self-hosted fonts
// and the strict CSP); visitors don't need them. Lighthouse flagged ~2 KiB of
// savings, nearly all comments and indentation, so this only does the safe part:
// drop comments, collapse whitespace, and trim spaces around punctuation that
// never needs them. Strings and url() contents are left exactly as written.
// Spaces before ":" are kept on purpose: "a :hover" and "a:hover" differ.

function minifyCss(css) {
  // Split into code and verbatim parts (strings, url()), so the punctuation
  // trimming below can never touch the inside of a string.
  const parts = [];
  let code = "";
  let i = 0;
  const n = css.length;
  const flush = () => { if (code) parts.push({ code: true, text: code }); code = ""; };
  while (i < n) {
    const ch = css[i];
    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? n : end + 2;
      code += " ";
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && css[j] !== ch) j += css[j] === "\\" ? 2 : 1;
      flush();
      parts.push({ code: false, text: css.slice(i, j + 1) });
      i = j + 1;
      continue;
    }
    // Unquoted url(...) only; a quoted one is handled by the string branch above,
    // which matters when the quoted value itself contains ")" (inline SVG data URIs).
    if ((ch === "u" || ch === "U") && /^url\(\s*[^\s"']/i.test(css.slice(i, i + 64))) {
      const end = css.indexOf(")", i);
      const stop = end === -1 ? n : end + 1;
      flush();
      parts.push({ code: false, text: css.slice(i, stop) });
      i = stop;
      continue;
    }
    code += ch;
    i++;
  }
  flush();
  return parts
    .map((p) => (p.code
      ? p.text
          .replace(/\s+/g, " ")
          .replace(/ ?([{};,>]) ?/g, "$1")
          .replace(/: /g, ":")
          .replace(/;}/g, "}")
      : p.text))
    .join("")
    .trim();
}

// Minify every <style>...</style> block in an HTML document, leaving the rest alone.
function minifyInlineStyles(html) {
  return html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_, open, css, close) => open + minifyCss(css) + close);
}

module.exports = { minifyCss, minifyInlineStyles };
