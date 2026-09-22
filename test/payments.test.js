const { test } = require("node:test");
const assert = require("node:assert/strict");
const p = require("../public/payments.js");

const LINK = "https://buy.stripe.com/test_9AQ4gy1234abcd";
const DONATE = "https://donate.stripe.com/abc123";

test("accepts Stripe's own hosted checkout links", () => {
  assert.equal(p.linkProblem(LINK), null);
  assert.equal(p.linkProblem(DONATE), null);
  assert.equal(p.isSafeLink(LINK), true);
});

test("refuses any payment page that isn't Stripe's", () => {
  // A generated app that can send buyers anywhere is a phishing flow, and the
  // customer could not tell from inside the builder that it had happened.
  for (const bad of [
    "https://evil.example.com/pay",
    "https://buy.stripe.com.evil.com/x",
    "https://paypal.me/someone",
    "http://buy.stripe.com/insecure",
  ]) {
    assert.ok(p.linkProblem(bad), bad);
    assert.equal(p.isSafeLink(bad), false, bad);
  }
});

test("refuses anything that could break out of the href attribute", () => {
  for (const bad of [
    'https://buy.stripe.com/x" onclick="alert(1)',
    "https://buy.stripe.com/x'><script>alert(1)</script>",
    "javascript:alert(1)",
    "https://buy.stripe.com/x with spaces",
    "data:text/html,<script>alert(1)</script>",
  ]) {
    assert.equal(p.isSafeLink(bad), false, bad);
  }
});

test("an empty or missing link is a clear message, not a crash", () => {
  assert.match(p.linkProblem(""), /Paste your Stripe/);
  assert.match(p.linkProblem(null), /Paste your Stripe/);
  assert.match(p.linkProblem("buy.stripe.com/x"), /https:\/\//);
});

test("substitutes every reference to a product's link", () => {
  const code = '<a href="{{pay:starter}}">Buy</a> <a href="{{pay:starter}}">Buy again</a>';
  const out = p.substitute(code, { starter: { url: LINK } });
  assert.equal(out.split(LINK).length - 1, 2);
  assert.ok(!out.includes("{{pay:"));
});

test("a removed or unknown product leaves a dead link, never visible braces", () => {
  const out = p.substitute('<a href="{{pay:gone}}">Buy</a>', { starter: { url: LINK } });
  assert.equal(out, '<a href="#">Buy</a>');
});

test("an unsafe stored link can never reach the page", () => {
  const out = p.substitute('<a href="{{pay:x}}">Buy</a>', { x: { url: "https://evil.example.com/pay" } });
  assert.equal(out, '<a href="#">Buy</a>', "validated again at substitution, not only at entry");
});

test("reports which products the code uses", () => {
  const code = '<a href="{{pay:starter}}">a</a><a href="{{pay:PRO}}">b</a><a href="{{pay:starter}}">c</a>';
  assert.deepEqual(p.placeholdersUsed(code), ["starter", "pro"]);
  assert.equal(p.hasPlaceholder(code), true);
  assert.equal(p.hasPlaceholder("<a href=/buy>Buy</a>"), false);
});

test("slugs are restricted and malformed placeholders are left alone", () => {
  assert.equal(p.validSlug("starter"), true);
  assert.equal(p.validSlug("pro_2"), true);
  assert.equal(p.validSlug("9lives"), false);
  assert.equal(p.validSlug("../etc"), false);
  const weird = "{{pay:}} {{pay:9x}} {{ pay:starter }}";
  assert.equal(p.substitute(weird, { starter: { url: LINK } }), weird);
});

test("what a buyer sees is length-bounded", () => {
  const item = p.normaliseItem({ label: "x".repeat(200), price: "y".repeat(50), url: "  " + LINK + "  " });
  assert.equal(item.label.length, 60);
  assert.equal(item.price.length, 24);
  assert.equal(item.url, LINK, "whitespace trimmed so a pasted link still validates");
});
