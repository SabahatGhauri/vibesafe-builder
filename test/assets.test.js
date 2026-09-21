const { test } = require("node:test");
const assert = require("node:assert/strict");
const a = require("../public/assets.js");

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==";

test("substitutes a slot for its image, everywhere it appears", () => {
  const code = '<img src="{{image:hero}}" alt="Our team"><div style="background:url({{image:hero}})">';
  const out = a.substitute(code, { hero: PNG });
  assert.equal(out.indexOf("{{image:"), -1, "no placeholder survives");
  assert.equal(out.split(PNG).length - 1, 2, "both occurrences replaced");
});

test("a slot with no image becomes a blank pixel, never visible braces", () => {
  const out = a.substitute('<img src="{{image:logo}}">', { hero: PNG });
  assert.ok(out.includes(a.BLANK_PIXEL));
  assert.ok(!out.includes("{{image:"), "a customer never sees {{image:logo}} on their page");
});

test("only image data URIs we produced are trusted", () => {
  for (const bad of [
    "data:text/html;base64,PHNjcmlwdD4=",
    "javascript:alert(1)",
    "data:image/svg+xml;base64,PHN2Zz48c2NyaXB0Pg==",
    "https://example.com/tracker.png",
    "",
    null,
    42,
  ]) {
    assert.equal(a.isSafeDataUri(bad), false, String(bad).slice(0, 40));
    const out = a.substitute('<img src="{{image:hero}}">', { hero: bad });
    assert.ok(out.includes(a.BLANK_PIXEL), "an untrusted value never reaches the page");
  }
  assert.equal(a.isSafeDataUri(PNG), true);
  assert.equal(a.isSafeDataUri(JPEG), true);
});

test("SVG uploads are refused — an SVG can carry a script", () => {
  const msg = a.rejectFile({ type: "image/svg+xml", size: 2000 });
  assert.match(msg, /SVG/);
  assert.equal(a.rejectFile({ type: "image/png", size: 2000 }), null);
  assert.equal(a.rejectFile({ type: "image/webp", size: 2000 }), null);
  assert.match(a.rejectFile({ type: "application/pdf", size: 10 }), /supported/);
  assert.match(a.rejectFile({ type: "image/png", size: 20 * 1024 * 1024 }), /12MB/);
  assert.match(a.rejectFile(null), /No file/);
});

test("reports which slots the code uses, once each", () => {
  const code = '<img src="{{image:hero}}"><img src="{{image:HERO}}"><img src="{{image:logo}}">';
  assert.deepEqual(a.placeholdersUsed(code), ["hero", "logo"]);
  assert.equal(a.hasPlaceholder(code), true);
  assert.equal(a.hasPlaceholder("<img src=/photo.png>"), false);
  assert.deepEqual(a.placeholdersUsed(null), []);
});

test("slot names are restricted, and malformed placeholders are left alone", () => {
  assert.equal(a.validSlot("hero"), true);
  assert.equal(a.validSlot("../../etc/passwd"), false);
  assert.equal(a.validSlot("anything-else"), false);
  const weird = "{{image:}} {{image:9bad}} {{ image:hero }}";
  assert.equal(a.substitute(weird, { hero: PNG }), weird, "nothing that isn't a real placeholder is touched");
});

test("embedded size is measurable before a publish is attempted", () => {
  assert.equal(a.embeddedBytes({}), 0);
  assert.equal(a.embeddedBytes({ hero: PNG, logo: JPEG }), PNG.length + JPEG.length);
  assert.equal(a.embeddedBytes(null), 0);
});

test("empty and non-string code is handled without throwing", () => {
  assert.equal(a.substitute("", { hero: PNG }), "");
  assert.equal(a.substitute(null, {}), "");
  assert.equal(a.substitute("<p>hi</p>", null), "<p>hi</p>");
});
