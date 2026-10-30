"use strict";

// Bot protection for the endpoints that create accounts, send email or spend
// money (model calls, headless-browser runs, hosting).
//
// What it deliberately leaves alone. Only the POST routes listed in RULES below
// are ever checked. Every page a visitor or crawler can GET - the landing page,
// blog, pricing, sitemap, robots.txt, published apps - passes straight through
// without a lookup, a counter or a challenge. That is on purpose: the site is
// being indexed and ranked right now, and Googlebot, Bingbot and the AI search
// crawlers (GPTBot, OAI-SearchBot, PerplexityBot, ClaudeBot...) only ever GET
// public pages. A bot blocker that sniffed user agents or challenged page loads
// would risk exactly the traffic we want. test/botGuard.test.js pins this.
//
// Three layers, cheapest first:
//
// 1. Honeypot. The sign-up and reset forms carry a hidden "website" field a
//    person never sees or fills in. Form-filling bots fill every field, so a
//    value there means a bot. It gets the same "check your email" answer a
//    person would, so it has no signal that it was caught, and nothing is sent.
//
// 2. Per-IP rate limits. A fixed-window counter per route and client address.
//    It lives in this function instance's memory, so on Vercel each warm
//    instance counts separately: it is a speed bump that stops one script
//    hammering an endpoint, not a global quota. The hard per-address limits
//    (signup email throttle, starter-build cap, form and report limits) stay in
//    the database where they already are.
//
// 3. Cloudflare Turnstile, on sign-up and password reset only, and only once
//    TURNSTILE_SECRET_KEY and TURNSTILE_SITE_KEY are set. Until then this layer
//    is a no-op and the forms work exactly as before.

const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const HONEYPOT_FIELD = "website";

const MINUTE = 60 * 1000;

// Generous enough that a person iterating quickly on an app never notices,
// tight enough that a loop does. Keys are "METHOD path"; a trailing "*" matches
// a prefix (the public form-submission route has the form id in its path).
const RULES = {
  "POST /api/signup": {
    limit: { max: 5, windowMs: 15 * MINUTE },
    honeypot: { message: "Check your email to confirm your account, then come back and log in." },
    captcha: true,
  },
  "POST /api/request-password-reset": {
    limit: { max: 5, windowMs: 15 * MINUTE },
    honeypot: { message: "If that email has an account, a reset link is on its way." },
    captcha: true,
  },
  "POST /api/welcome-email": { limit: { max: 10, windowMs: 10 * MINUTE } },
  "POST /api/generate": { limit: { max: 40, windowMs: 10 * MINUTE } },
  "POST /api/estimate": { limit: { max: 80, windowMs: 10 * MINUTE } },
  "POST /api/launch-check": { limit: { max: 10, windowMs: 10 * MINUTE } },
  "POST /api/publish": { limit: { max: 30, windowMs: 10 * MINUTE } },
  "POST /api/preview-link": { limit: { max: 30, windowMs: 10 * MINUTE } },
  "POST /api/validate-key": { limit: { max: 20, windowMs: 10 * MINUTE } },
  "POST /api/checkout": { limit: { max: 10, windowMs: 10 * MINUTE } },
  "POST /api/report": { limit: { max: 10, windowMs: 10 * MINUTE } },
  "POST /api/forms/public/*": { limit: { max: 30, windowMs: 10 * MINUTE } },
};

function ruleFor(method, path, rules = RULES) {
  const exact = rules[`${method} ${path}`];
  if (exact) return { key: `${method} ${path}`, rule: exact };
  for (const key of Object.keys(rules)) {
    if (!key.endsWith("*")) continue;
    const [m, prefix] = key.slice(0, -1).split(" ");
    if (m === method && path.startsWith(prefix)) return { key, rule: rules[key] };
  }
  return null;
}

// Same order lib/signup.js uses: Vercel's x-real-ip is the single client
// address; x-forwarded-for's first hop is the fallback; the socket last (local
// runs and tests).
function clientIp(req) {
  const real = String(req.headers["x-real-ip"] || "").trim();
  if (real) return real;
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (fwd) return fwd;
  return req.socket?.remoteAddress || "unknown";
}

function createCounter({ now = Date.now } = {}) {
  const buckets = new Map();
  let lastSweep = now();
  return {
    // Returns { allowed, retryAfterSec }.
    hit(key, { max, windowMs }) {
      const t = now();
      // Drop expired buckets now and then so a long-lived instance doesn't
      // grow a map entry for every address it has ever seen.
      if (t - lastSweep > 5 * MINUTE) {
        for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k);
        lastSweep = t;
      }
      let b = buckets.get(key);
      if (!b || b.resetAt <= t) {
        b = { count: 0, resetAt: t + windowMs };
        buckets.set(key, b);
      }
      b.count += 1;
      if (b.count > max) return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((b.resetAt - t) / 1000)) };
      return { allowed: true, retryAfterSec: 0 };
    },
    size: () => buckets.size,
  };
}

async function verifyTurnstile({ secret, token, ip, fetchImpl = fetch }) {
  if (!token || typeof token !== "string" || token.length > 2048) return { ok: false, reason: "missing" };
  const body = new URLSearchParams({ secret, response: token });
  if (ip && ip !== "unknown") body.set("remoteip", ip);
  const r = await fetchImpl(TURNSTILE_VERIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await r.json().catch(() => ({}));
  return data && data.success === true ? { ok: true } : { ok: false, reason: "rejected" };
}

function botGuard({
  rules = RULES,
  turnstileSecret = process.env.TURNSTILE_SECRET_KEY || "",
  fetchImpl = fetch,
  now = Date.now,
  log = console,
} = {}) {
  const counter = createCounter({ now });

  const middleware = async (req, res, next) => {
    // Pages, assets, crawlers: never touched. Only listed POST routes go on.
    if (req.method !== "POST") return next();
    const match = ruleFor(req.method, req.path, rules);
    if (!match) return next();
    const { key, rule } = match;
    const body = req.body && typeof req.body === "object" ? req.body : {};

    if (rule.honeypot) {
      const trap = body[HONEYPOT_FIELD];
      if (trap !== undefined && String(trap).trim() !== "") {
        log.warn?.(`[botGuard] honeypot tripped on ${key}`);
        return res.json({ message: rule.honeypot.message });
      }
    }

    const ip = clientIp(req);
    if (rule.limit) {
      const { allowed, retryAfterSec } = counter.hit(`${key}|${ip}`, rule.limit);
      if (!allowed) {
        log.warn?.(`[botGuard] rate limit hit on ${key}`);
        res.setHeader("Retry-After", String(retryAfterSec));
        return res.status(429).json({
          error: "Too many requests from your network. Please wait a few minutes and try again.",
          reason: "rate_limited",
        });
      }
    }

    if (rule.captcha && turnstileSecret) {
      const token = body.turnstileToken || req.headers["cf-turnstile-response"];
      let result;
      try {
        result = await verifyTurnstile({ secret: turnstileSecret, token, ip, fetchImpl });
      } catch (err) {
        // Fails closed, the same way the signup throttle does: if we can't
        // check, an outage must not turn the form back into an open door.
        log.error?.("[botGuard] Turnstile check failed:", err && err.message);
        return res.status(503).json({ error: "Couldn't verify you're human just now. Try again shortly.", reason: "captcha_unavailable" });
      }
      if (!result.ok) {
        return res.status(403).json({
          error: "Please complete the \"I'm human\" check and try again.",
          reason: "captcha_failed",
        });
      }
    }

    next();
  };
  middleware.counter = counter;
  return middleware;
}

module.exports = { botGuard, ruleFor, clientIp, createCounter, verifyTurnstile, RULES, HONEYPOT_FIELD, TURNSTILE_VERIFY_URL };
