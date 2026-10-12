const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

// Search engines and AI answer engines only tie pages to the brand when every
// page points at the same Organization / SoftwareApplication nodes. These
// tests keep the JSON-LD parseable and keep those links from drifting.
const PUBLIC = path.join(__dirname, "..", "public");
const ORG = "https://vibesafebuilder.com/#organization";
const SOFTWARE = "https://vibesafebuilder.com/#software";

function htmlFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return htmlFiles(p);
    return e.name.endsWith(".html") ? [p] : [];
  });
}

function jsonLd(file) {
  const html = fs.readFileSync(file, "utf8");
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
  return [...html.matchAll(re)].map((m) => JSON.parse(m[1]));
}

test("every JSON-LD block on every public page parses", () => {
  for (const file of htmlFiles(PUBLIC)) {
    assert.doesNotThrow(() => jsonLd(file), `bad JSON-LD in ${path.relative(PUBLIC, file)}`);
  }
});

test("blog posts name the shared Organization as publisher", () => {
  for (const file of htmlFiles(path.join(PUBLIC, "blog"))) {
    const post = jsonLd(file).find((d) => d["@type"] === "BlogPosting");
    assert.ok(post, `${path.basename(file)} has no BlogPosting`);
    assert.strictEqual(post.publisher["@id"], ORG, path.basename(file));
    assert.strictEqual(post.about["@id"], SOFTWARE, path.basename(file));
  }
});

test("marketing pages are tied to the product entity", () => {
  const pages = ["about", "pricing", "user-guide", "compare", "security", "how-it-works", "deploy-guide", "demo", "blog"];
  for (const name of pages) {
    const page = jsonLd(path.join(PUBLIC, `${name}.html`)).find((d) => /Page$/.test(d["@type"]) && d.about);
    assert.ok(page, `${name}.html has no WebPage node`);
    assert.strictEqual(page.about["@id"], SOFTWARE, name);
    assert.strictEqual(page.publisher["@id"], ORG, name);
  }
});

test("homepage Organization has a raster logo and its LinkedIn page", () => {
  const org = jsonLd(path.join(PUBLIC, "landing.html")).find((d) => d["@type"] === "Organization");
  assert.match(org.logo.url, /\.png$/);
  assert.ok(org.sameAs.some((u) => u.startsWith("https://www.linkedin.com/company/")), "LinkedIn company page missing from sameAs");
});
