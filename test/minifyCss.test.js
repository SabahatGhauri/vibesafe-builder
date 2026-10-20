const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const { minifyCss, minifyInlineStyles } = require("../lib/minifyCss");

test("drops comments and whitespace", () => {
  assert.strictEqual(minifyCss("/* note */\n.a > b , .c { color : red ; }\n"), ".a>b,.c{color :red}");
});

test("leaves strings and url() untouched", () => {
  const css = '.q::after { content: "a , b : c; }"; background: url( "/x y.png" ); }';
  assert.strictEqual(minifyCss(css), '.q::after{content:"a , b : c; }";background:url( "/x y.png" )}');
});

test("keeps the space before a pseudo-class", () => {
  assert.strictEqual(minifyCss(".nav a :hover { x: 1 }"), ".nav a :hover{x:1}");
});

test("only rewrites <style> blocks in landing.html", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "landing.html"), "utf8");
  const out = minifyInlineStyles(html);
  assert.ok(out.length < html.length);
  const strip = (s) => s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "<style></style>");
  assert.strictEqual(strip(out), strip(html));
  assert.ok(!/<style\b[^>]*>[\s\S]*?\/\*[\s\S]*?<\/style>/i.test(out), "no CSS comments left");
});
