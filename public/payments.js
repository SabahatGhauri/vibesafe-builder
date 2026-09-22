// Taking money in a generated app, phase 1: Stripe Payment Links.
//
// The customer creates the link in their own Stripe dashboard and pastes it
// here. Stripe hosts the checkout page, so no secret key exists anywhere in
// this product, nothing sensitive reaches the generated code, and the money
// goes directly to the customer's own Stripe account. We never touch it.
//
// Links are referenced by placeholder - {{pay:starter}} - for the same reason
// images are: a model asked to reproduce a 40-character URL from memory will
// eventually get one character wrong, and a broken checkout link is worse than
// no checkout link. Substitution happens at preview, publish and download.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.payments = api;
})(typeof self !== "undefined" ? self : this, function () {
  const MAX_ITEMS = 5;
  const PLACEHOLDER = /\{\{pay:([a-z][a-z0-9_-]{0,23})\}\}/gi;

  // Only Stripe's own hosted checkout domains. An arbitrary URL here would let
  // a generated app send buyers to any payment page at all, which is exactly
  // the shape of a phishing flow - and the customer could not tell from inside
  // the builder that it had happened.
  const ALLOWED_HOSTS = ["buy.stripe.com", "donate.stripe.com"];

  // Deliberately strict: the value ends up inside an href, so anything that
  // could terminate the attribute or introduce a new one is refused outright
  // rather than escaped and hoped for.
  const SAFE_URL = /^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9/_\-?=&.%+]*$/;

  function linkProblem(url) {
    const value = String(url || "").trim();
    if (!value) return "Paste your Stripe payment link.";
    if (!/^https:\/\//i.test(value)) return "The link must start with https://";
    if (!SAFE_URL.test(value)) return "That doesn't look like a payment link — check for stray spaces or characters.";
    let host;
    try {
      host = new URL(value).hostname.toLowerCase();
    } catch {
      return "That isn't a valid web address.";
    }
    if (!ALLOWED_HOSTS.includes(host)) {
      return "Only Stripe payment links are accepted (buy.stripe.com or donate.stripe.com). Create one in your Stripe dashboard under Payment links.";
    }
    return null;
  }

  function isSafeLink(url) {
    return linkProblem(url) === null;
  }

  function validSlug(slug) {
    return /^[a-z][a-z0-9_-]{0,23}$/.test(String(slug || ""));
  }

  function slotPlaceholder(slug) {
    return "{{pay:" + slug + "}}";
  }

  // An unknown or removed item resolves to "#" rather than being left as
  // literal braces: a dead button is confusing, "{{pay:starter}}" in a href is
  // broken in a way that makes the whole app look unfinished.
  function substitute(code, items) {
    if (typeof code !== "string" || !code) return code || "";
    const map = items || {};
    return code.replace(PLACEHOLDER, function (_m, slug) {
      const item = map[String(slug).toLowerCase()];
      return item && isSafeLink(item.url) ? item.url : "#";
    });
  }

  function placeholdersUsed(code) {
    if (typeof code !== "string") return [];
    const found = [];
    const re = new RegExp(PLACEHOLDER.source, "gi");
    let m;
    while ((m = re.exec(code)) !== null) {
      const slug = m[1].toLowerCase();
      if (!found.includes(slug)) found.push(slug);
    }
    return found;
  }

  function hasPlaceholder(code) {
    return placeholdersUsed(code).length > 0;
  }

  // Everything a customer types about a product is shown to buyers, so it is
  // length-bounded here and escaped where it is rendered.
  function normaliseItem(item) {
    return {
      label: String((item && item.label) || "").trim().slice(0, 60),
      price: String((item && item.price) || "").trim().slice(0, 24),
      url: String((item && item.url) || "").trim(),
    };
  }

  return {
    MAX_ITEMS,
    ALLOWED_HOSTS,
    linkProblem,
    isSafeLink,
    validSlug,
    slotPlaceholder,
    substitute,
    placeholdersUsed,
    hasPlaceholder,
    normaliseItem,
  };
});
