const path = require("path");
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const { sendEmail, welcomeEmailHtml, proActivationEmailHtml } = require("./email");
const { registerAppBackendRoutes, provisionAppKey, injectBackendConfig } = require("./appBackend");

// Loaded from environment variables (set in Vercel project settings, or in
// the local shell for dev) — never hardcoded in source. The anon key is
// meant to be public (like any client-side Supabase key; Row Level Security
// governs what it can read/write), but it still isn't checked into the
// codebase, so a leaked deploy or repo can't be blamed on it.
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const supabase = SUPABASE_URL && SUPABASE_ANON_KEY ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// Service-role client — genuinely privileged (bypasses RLS). Used only
// server-side for the webhook and managed-plan usage accounting; never sent
// to the browser.
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null;

const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID;
// Signature verification is pure crypto and doesn't call the Stripe API, so a
// real secret key isn't required just to run stripe.webhooks.constructEvent —
// but IS required for /api/checkout below, which actually calls the Stripe API.
// apiVersion pinned explicitly: the installed stripe npm package (v17) defaults to
// an older API version than this account's "Managed Payments" setup requires —
// without this, checkout.sessions.create() is rejected outright.
const stripe = new Stripe(STRIPE_SECRET_KEY || "sk_placeholder_webhook_verify_only", { apiVersion: "2025-03-31.basil" });

const MANAGED_MONTHLY_BUDGET = 10.0; // real dollars of Anthropic usage covered by the $15/mo plan
const SITE_URL = process.env.SITE_URL || "https://vibesafebuilder.com";

const PUBLIC_DIR = path.join(__dirname, "..", "public");

const app = express();

/* ---------------- Stripe webhook (registered BEFORE express.json() — needs the raw body) ---------------- */

app.post("/api/stripe-webhook", express.raw({ type: "application/json" }), async (req, res) => {
  if (!STRIPE_WEBHOOK_SECRET || !supabaseAdmin) {
    return res.status(503).send("Managed-plan webhook isn't configured on this server.");
  }
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send("Signature verification failed: " + err.message);
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const email = session.customer_details?.email || session.customer_email;
      if (email) await activateManagedAccess(email, session.customer);
    } else if (event.type === "customer.subscription.deleted" || event.type === "customer.subscription.updated") {
      const sub = event.data.object;
      const status = sub.status === "active" || sub.status === "trialing" ? "active" : "canceled";
      await supabaseAdmin.from("subscriptions").update({ status, updated_at: new Date().toISOString() }).eq("stripe_customer_id", sub.customer);
    }
    res.json({ received: true });
  } catch (err) {
    console.error("Webhook handling error:", err);
    res.status(500).send("Webhook handler error");
  }
});

async function findUserIdByEmail(email) {
  const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, {
    headers: { apikey: SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}` },
  });
  if (!r.ok) return null;
  const body = await r.json();
  const users = Array.isArray(body) ? body : body.users;
  return Array.isArray(users) && users.length ? users[0].id : null;
}

async function activateManagedAccess(email, stripeCustomerId) {
  let userId = await findUserIdByEmail(email);
  let isNewUser = false;
  if (!userId) {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({ email, email_confirm: true });
    if (error) {
      console.error("Could not provision managed-plan account for", email, error);
      return;
    }
    userId = data.user.id;
    isNewUser = true;
  }
  await supabaseAdmin.from("subscriptions").upsert({
    user_id: userId,
    stripe_customer_id: stripeCustomerId,
    status: "active",
    updated_at: new Date().toISOString(),
  });

  // welcome.html promises "you'll get an email with your access details shortly" —
  // this is what makes that true. A brand-new account (customer paid before ever
  // signing up) has no password and no OAuth identity yet, so it needs a real way in:
  // generate a Supabase recovery link ourselves (admin.generateLink() deliberately
  // does NOT send anything on its own — it just returns a link) and send it in our own
  // branded email via Resend. This replaces the old signInWithOtp() magic-link hack,
  // which stopped making sense once sign-in moved to email+password/OAuth — a magic
  // link doesn't set a password, so a customer who used one could never log back in
  // the normal way afterward. An existing account just gets a plain confirmation —
  // they already have a way in. Failure here must never undo the activation above:
  // the customer is still a paying, active managed user even if the email attempt
  // fails (e.g. Resend not configured yet) — hello@vibesafebuilder.com is the fallback.
  try {
    let setPasswordUrl = null;
    if (isNewUser) {
      const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
        type: "recovery",
        email,
        options: { redirectTo: `${SITE_URL}/app` },
      });
      if (linkError) console.error("Could not generate password-set link for", email, linkError);
      else setPasswordUrl = linkData?.properties?.action_link || null;
    }
    const result = await sendEmail({
      to: email,
      subject: "You're on the Pro plan — VibeSafe Builder",
      html: proActivationEmailHtml({ name: null, setPasswordUrl }),
    });
    if (!result.ok) console.error("Could not send Pro-activation email to", email, result.error);
  } catch (err) {
    console.error("Could not send Pro-activation email to", email, err);
  }
}

app.use(express.json({ limit: "5mb" }));
app.use(express.static(PUBLIC_DIR, { index: false }));

/* ---------------- managed-plan checkout (server-created session, replaces the static Payment Link) ---------------- */

// Previously the "Get managed access" button linked straight to a static Stripe
// Payment Link. That link's success redirect and its webhook destination both live
// entirely inside Stripe's dashboard UI, invisible to this codebase and easy to
// misconfigure (or configure once in the wrong Stripe account) with nothing here to
// catch it — which is exactly what happened. Creating the Checkout Session here
// instead makes the redirect explicit and version-controlled, and ties checkout
// directly to whichever account STRIPE_SECRET_KEY actually belongs to — the same
// account that must own the webhook destination, removing the "which account?"
// ambiguity a dashboard-configured Payment Link doesn't protect against.
// Kill switch from 2026-08-16 removed: root cause was VibeSafe and VibeSafe Builder
// sharing one Stripe account, letting cross-product Dashboard activity (and Stripe
// Link's cross-merchant autofill) attach the wrong customer to a session. Fixed by
// giving VibeSafe Builder its own dedicated Stripe account — STRIPE_SECRET_KEY,
// STRIPE_PRICE_ID, and STRIPE_WEBHOOK_SECRET all now point to it, fully isolated.
const MANAGED_CHECKOUT_DISABLED = false;

app.post("/api/checkout", async (req, res) => {
  if (MANAGED_CHECKOUT_DISABLED) {
    return res.status(503).json({ error: "Managed-plan signup is temporarily paused. Please check back soon, or use Bring Your Own Key in the meantime." });
  }
  if (!STRIPE_SECRET_KEY || !STRIPE_PRICE_ID) {
    return res.status(503).json({ error: "Managed-plan checkout isn't configured on this server yet." });
  }
  try {
    const { email = null } = req.body || {};
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      customer_email: email || undefined, // let Stripe collect it at checkout if not already known
      success_url: `${SITE_URL}/welcome`,
      cancel_url: `${SITE_URL}/#pricing`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error("Could not create checkout session:", err);
    res.status(500).json({ error: "Could not start checkout: " + (err.message || "unknown error") });
  }
});

// Origin isolation for published apps. Right now /p/:id serves arbitrary generated
// JS on this same origin, which means it shares localStorage with the builder itself
// — a published app can read (and exfiltrate) another visitor's BYOK API key or
// managed-plan session token. The security scan and CSP below reduce that, but
// neither closes it completely; only serving published apps from a genuinely
// separate origin does (same approach CodePen/JSFiddle/Replit use for user code).
// Once ISOLATED_APPS_HOST is set (after its DNS record exists and the subdomain is
// attached to this Vercel project), every /p/* request on the main domain redirects
// there instead. Until then this is a complete no-op — zero behavior change — so it's
// safe to ship now and flip on later as a one-line config change, not a code change.
const ISOLATED_APPS_HOST = process.env.ISOLATED_APPS_HOST;
app.use((req, res, next) => {
  if (ISOLATED_APPS_HOST && req.path.startsWith("/p/") && req.hostname !== ISOLATED_APPS_HOST) {
    return res.redirect(302, `https://${ISOLATED_APPS_HOST}${req.originalUrl}`);
  }
  next();
});

// Browsers auto-probe /favicon.ico on every top-level navigation regardless of the
// declared <link rel="icon">; without this it 404s and Chrome logs it as a console
// error — including inside Launch Check's headless pass, where it shows up as a
// false-positive finding on every single app.
app.get("/favicon.ico", (req, res) => res.status(204).end());

// Landing page at root; the builder lives at /app; post-checkout redirect lands at /welcome
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "landing.html")));
app.get("/app", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

// Public, non-secret config the browser needs for the managed-plan sign-in flow.
// The anon key is designed to be public (same as any client-side Supabase key);
// it grants nothing beyond what RLS already allows.
app.get("/api/config", (req, res) => {
  res.json({
    managedPlanAvailable: !!(SUPABASE_URL && SUPABASE_ANON_KEY),
    supabaseUrl: SUPABASE_URL || null,
    supabaseAnonKey: SUPABASE_ANON_KEY || null,
    managedBudget: MANAGED_MONTHLY_BUDGET,
  });
});
app.get("/welcome", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "welcome.html")));

/* ---------------- publishing (Supabase-backed — survives serverless restarts) ---------------- */

// Server-side security gate — publishing is refused for critical issues even if
// the client-side check was bypassed.
const PUBLISH_BLOCKERS = [
  { label: "hardcoded API key or secret", re: /(sk-[a-zA-Z0-9_-]{18,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|ghp_[a-zA-Z0-9]{30,}|(api[_-]?key|secret|token|password)\s*[:=]\s*["'][A-Za-z0-9_\-\/+]{16,}["'])/i },
  { label: "eval() / dynamic code execution", re: /\beval\s*\(|new\s+Function\s*\(/ },
  // Matches the client-side "No passwords stored in localStorage" check in
  // public/app.js — was missing here, which meant this critical-severity
  // finding was only enforced client-side and could be bypassed by calling
  // /api/publish directly.
  {
    label: "password stored in localStorage",
    re: /localStorage\.(setItem\s*\(\s*["'][^"']*(password|passwd|secret)|[a-zA-Z_]*(password|passwd|secret))/i,
  },
  // Published apps run on OUR origin (vibesafebuilder.com/p/:id), so their JS shares
  // localStorage with the builder itself — a published app that references our own
  // internal storage keys is attempting to read another visitor's BYOK API key or
  // managed-plan session token. This is a targeted, low-false-positive check (a
  // legitimate generated app has no organic reason to reference these exact names);
  // it does not catch a fully generic "enumerate every localStorage key" attack —
  // see the CSP on /p/:id below for a second layer that limits what a successful
  // read can be exfiltrated to.
  {
    label: "reads the builder's own internal storage keys (possible credential theft)",
    re: /vc_apiKey|vc_project\b|vc_cap\b|sb-[\w-]+-auth-token|supabase\.auth\.(token|session)/i,
  },
];

function randomId() {
  return require("crypto").randomBytes(6).toString("base64url");
}

// Publishing is one server-side operation from the caller's perspective: the browser
// posts code once and gets back a finished app. It never orchestrates the individual
// steps (create row -> provision credentials -> write final artifact) or has to know
// their ordering. Each stage is named below so a failure can say WHICH stage failed
// rather than just "publish failed".
//
// Postgres has no cross-statement transaction available through the Supabase REST
// client, so this is sequenced-and-recoverable rather than truly atomic: the ordering
// respects the app_backend_keys.app_id -> published_apps.id foreign key (parent first,
// always), every step is idempotent, and a failure after the app row exists leaves a
// working published app rather than a half-created one.
app.post("/api/publish", async (req, res) => {
  if (!supabase) return res.status(503).json({ error: "Publishing isn't configured on this server (missing SUPABASE_URL / SUPABASE_ANON_KEY)." });
  const { code = "", id = null, publishKey = null } = req.body;

  // ---- stage: VALIDATING ----
  if (!/<html[\s>]/i.test(code) || code.length > 2_000_000) {
    return res.status(400).json({ error: "Not a valid app file.", stage: "validating" });
  }

  // Replay protection: a retried request (slow connection, refresh mid-publish,
  // double-click) carrying the same publishKey returns the original result instead
  // of running the whole publish again. Deliberate republishes send a fresh key.
  if (publishKey && supabaseAdmin) {
    const { data: prior } = await supabaseAdmin
      .from("publish_attempts")
      .select("app_id, status")
      .eq("publish_key", publishKey)
      .maybeSingle();
    if (prior && prior.status === "published") {
      return res.json({ id: prior.app_id, url: `/p/${prior.app_id}`, replayed: true });
    }
  }

  // ---- stage: SECURITY_CHECK ----
  const blockers = PUBLISH_BLOCKERS.filter((b) => b.re.test(code)).map((b) => b.label);
  if (blockers.length) {
    return res.status(422).json({ error: "Blocked by security scan", blockers, stage: "security_check" });
  }

  const publishId = id && /^[a-zA-Z0-9_-]{6,24}$/.test(id) ? id : randomId();

  async function recordAttempt(status, failureStage, failureReason) {
    if (!publishKey || !supabaseAdmin) return;
    try {
      await supabaseAdmin.from("publish_attempts").upsert(
        {
          publish_key: publishKey,
          app_id: publishId,
          status,
          failure_stage: failureStage || null,
          failure_reason: failureReason || null,
        },
        { onConflict: "publish_key" }
      );
    } catch (err) {
      // Bookkeeping only — never let it affect the publish result itself.
      console.error("Could not record publish attempt", publishKey, err);
    }
  }

  // ---- stage: BUILDING ----
  // Installability wraps the AI-generated code at publish time only — the stored
  // version history / diffs stay exactly what the model produced.
  const { injectPWATags } = require("./pwa");
  let html = injectPWATags(code, { swUrl: `/p/${publishId}/sw.js` });

  // ---- stage: PUBLISHING (parent row first — see FK note below) ----
  const { error } = await supabase
    .from("published_apps")
    .upsert({ id: publishId, html, updated_at: new Date().toISOString() });
  if (error) {
    await recordAttempt("failed", "publishing", error.message);
    return res.status(500).json({ error: "Could not save the published app: " + error.message, stage: "publishing" });
  }

  // ---- stage: PROVISIONING ----
  // Backend credentials are injected at publish time for the same reason the PWA tags
  // are: an app only gets a stable identity once it's published. (That's also why the
  // Preview iframe and Launch Check — which run the raw model output, never routed
  // through here — simply see window.VIBESAFE_APP_ID as undefined; generated code is
  // instructed to guard on that and fall back to localStorage.)
  // This runs AFTER the upsert above, never before: app_backend_keys.app_id has a
  // foreign key to published_apps(id), so the parent row must exist first or a
  // brand-new app's first publish is rejected outright. provisionAppKey() is
  // get-or-create against a PRIMARY KEY on app_id, so retries reuse the existing
  // credential rather than minting duplicates.
  let backendReady = false;
  if (supabaseAdmin) {
    try {
      const appKey = await provisionAppKey(supabaseAdmin, publishId);
      html = injectBackendConfig(html, { appId: publishId, appKey });
      const { error: cfgError } = await supabase
        .from("published_apps")
        .upsert({ id: publishId, html, updated_at: new Date().toISOString() });
      if (cfgError) throw cfgError;
      backendReady = true;
    } catch (err) {
      // Deliberately non-fatal: the app is already saved and serving correctly by this
      // point. Failing the whole publish here would throw away a working deployment
      // over an optional capability the generated code already guards for.
      console.error("Could not provision backend for", publishId, err);
      await recordAttempt("published_without_backend", "provisioning", err.message);
      return res.json({ id: publishId, url: `/p/${publishId}`, backendReady: false });
    }
  }

  await recordAttempt("published");
  res.json({ id: publishId, url: `/p/${publishId}`, backendReady });
});

app.get("/p/:id/sw.js", (req, res) => {
  if (!/^[a-zA-Z0-9_-]{6,24}$/.test(req.params.id)) return res.status(400).end();
  const { buildServiceWorker } = require("./pwa");
  res.type("application/javascript").send(buildServiceWorker(req.params.id, `/p/${req.params.id}`));
});

/* ---------------- launch check (runtime validation spike) ---------------- */

// A real-origin page for Launch Check to navigate to before writing the app's HTML
// in — see the comment in launchCheck.js for why this matters (localStorage access
// and JS-realm reset between the desktop and mobile passes).
app.get("/__lc-blank", (req, res) => {
  res.type("html").send("<!DOCTYPE html><html><head></head><body></body></html>");
});

app.post("/api/launch-check", async (req, res) => {
  const { code = "" } = req.body;
  if (!/<html[\s>]/i.test(code) || code.length > 2_000_000) {
    return res.status(400).json({ error: "Not a valid app file." });
  }
  try {
    const { runLaunchCheck } = require("./launchCheck");
    const result = await runLaunchCheck(code);
    res.json(result);
  } catch (err) {
    console.error("Launch Check error:", err);
    res.status(500).json({ error: "Launch Check failed: " + (err.message || "unknown error") });
  }
});

app.get("/p/:id", async (req, res) => {
  if (!supabase) return res.status(503).send("Publishing isn't configured on this server.");
  if (!/^[a-zA-Z0-9_-]{6,24}$/.test(req.params.id)) return res.status(400).send("Bad app id");
  const { data, error } = await supabase
    .from("published_apps")
    .select("html")
    .eq("id", req.params.id)
    .single();
  if (error || !data) return res.status(404).send("App not found");
  // Published apps share this origin with the builder (see PUBLISH_BLOCKERS above for
  // why that matters). This CSP is a second layer, not a fix on its own: it can't stop
  // a script from reading localStorage — same-origin JS always can — but it does stop
  // a successful read from being exfiltrated to a third party (fetch/XHR/beacon/image
  // pixel to anywhere but this domain and the same CDN allowlist the security scan
  // already treats as legitimate). It does NOT stop the app from calling our own
  // same-origin API with a stolen token; only serving published apps from a separate
  // origin closes that path completely.
  res.set(
    "Content-Security-Policy",
    "default-src 'self' data: blob:; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com; " +
      "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net; " +
      "img-src 'self' data: blob: https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com; " +
      "connect-src 'self' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com; " +
      "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self';"
  );
  res.set("Content-Type", "text/html; charset=utf-8").send(data.html);
});

const MODEL = "claude-opus-5";
// USD per million tokens for claude-opus-5 (same as Opus 4.8 — drop-in price match)
const INPUT_PER_MTOK = 5.0;
const OUTPUT_PER_MTOK = 25.0;

const SYSTEM_PROMPT = `You are the code generator inside VibeSafe Builder, a vibe-coding app for non-programmers.
You build and edit SINGLE-FILE web apps (one complete HTML document with inline <style> and <script>).

OUTPUT FORMAT — always reply with exactly:
1. One short friendly sentence (max 25 words) saying what you did.
2. A single fenced code block: \`\`\`html ... \`\`\` containing the COMPLETE updated HTML document.
Never output partial files, multiple code blocks, or explanations after the code.

EDITING RULES (the user's previous app is provided as CURRENT CODE):
- Make the smallest change that fulfils the request. Preserve everything that already works — layout, styles, features, data.
- Never rewrite or restyle parts the user did not ask about.
- If the user reports a bug you already tried to fix, do NOT repeat the same fix. Re-diagnose from scratch and take a different approach.

SECURITY RULES (non-negotiable):
- NEVER hardcode API keys, tokens, passwords, or secrets of any kind. If a feature needs a key, build the UI to ask the user for it at runtime and keep it in memory only.
- No third-party analytics or tracking. Load external libraries only from https:// CDNs and only when truly needed.
- Never send user data to external servers unless the user explicitly asked for that integration.
- Don't use eval() or new Function().

QUALITY RULES:
- The app must be complete and immediately usable — working buttons, sensible empty states, no TODOs or placeholders.
- Distinctive modern design: real color palette, good typography and spacing. Avoid generic AI-styling clichés (purple gradients on white, Inter-only, cookie-cutter cards).
- Mobile-friendly by default. Persist user data with localStorage where it makes sense.

BACKEND DATA (optional — only when the app clearly needs shared/cross-device data):
Most apps should just use localStorage — simpler, no backend needed. Only use the backend
API below when the request clearly implies data shared between multiple people or persisting
across devices/browsers — e.g. "a shared guestbook", "a leaderboard everyone can see",
"a list my whole team edits". For a single-user tool with no such signal (a personal todo
list, a calculator, a habit tracker), use localStorage — do not add the backend API "just
in case."

When it IS needed: window.VIBESAFE_APP_ID / VIBESAFE_APP_KEY / VIBESAFE_BACKEND_URL are only
defined once the app has been published — guard every call with \`if (window.VIBESAFE_APP_ID)\`
and fall back to localStorage (or a short "publish to enable shared data" message) otherwise,
since the preview canvas has no app id yet. Send both x-app-id and x-app-key headers.
- Create: POST {VIBESAFE_BACKEND_URL}/records  body {collection, data}
- List:   GET  {VIBESAFE_BACKEND_URL}/records?collection=NAME  ->  {records:[{id,data,createdAt}], hasMore}
- Update: PUT  {VIBESAFE_BACKEND_URL}/records/:id  body {data}
- Delete: DELETE {VIBESAFE_BACKEND_URL}/records/:id
\`data\` is any JSON object, max 8KB, and each app is capped at 1000 records.

END-USER ACCOUNTS (optional — when the app needs each person to see only THEIR own data):
The app can have its own signup/login, separate from anything else. Use this when the
request implies private per-person data — "parents register and see their own children",
"each user has their own saved items", "log in to see your bookings".
- Sign up: POST {VIBESAFE_BACKEND_URL}/auth/signup  body {username, password}  -> {token, user}
- Log in:  POST {VIBESAFE_BACKEND_URL}/auth/login   body {username, password}  -> {token, user}
- Who am I: GET {VIBESAFE_BACKEND_URL}/auth/me  -> {user}
Store the returned token (localStorage is fine — it's that visitor's own token) and send it
as an \`Authorization: Bearer <token>\` header alongside x-app-id/x-app-key on record calls.
Passwords must be at least 8 characters.

How visibility works — this is the important part:
- Record created while signed in  -> PRIVATE to that user (only they can read/edit/delete it).
- Record created while signed in with {shared: true} in the body -> visible to everyone,
  but still owned by that user, so only they can edit or delete it. Use this for things like
  public posts or leaderboard entries where authorship matters.
- Record created while signed out -> shared and unowned; anyone can read, edit or delete it.
  Fine for a guestbook, wrong for anything personal.
- GET /records returns shared records plus the signed-in user's own. Add \`&mine=true\` to
  return ONLY the signed-in user's records.
Never build your own password check in the generated app's JavaScript, and never store a
password in a record — always use the auth endpoints above, which hash server-side.`;

/* ---------------- managed-plan auth & usage ---------------- */

function currentPeriod() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Validates the managed-plan session token (from Supabase magic-link sign-in).
// Returns the Supabase user object, or null if absent/invalid — falls through
// to BYOK mode either way, so a bad/expired token never hard-fails the request.
async function getManagedUser(req) {
  const token = req.header("x-vc-session");
  if (!token || !supabaseAdmin) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

async function getManagedUsage(userId) {
  const period = currentPeriod();
  const { data } = await supabaseAdmin
    .from("managed_usage")
    .select("dollars_spent, build_count")
    .eq("user_id", userId)
    .eq("period", period)
    .maybeSingle();
  return { period, spent: data?.dollars_spent || 0, builds: data?.build_count || 0 };
}

// dollars_spent tracks EVERY generation attempt, successful or not — Anthropic
// bills us for the tokens either way, so this is what actually protects our
// $10/mo budget. build_count tracks successes only, since that's the number
// shown to the user ("3 builds this month") and failures were never meant to
// count against THEM — those are two different promises and must stay decoupled,
// or a burst of failed generations becomes unlimited, unbudgeted spend on us.
async function recordManagedUsage(userId, cost, succeeded) {
  const period = currentPeriod();
  const { data } = await supabaseAdmin
    .from("managed_usage")
    .select("dollars_spent, build_count")
    .eq("user_id", userId)
    .eq("period", period)
    .maybeSingle();
  await supabaseAdmin.from("managed_usage").upsert({
    user_id: userId,
    period,
    dollars_spent: (data?.dollars_spent || 0) + cost,
    build_count: (data?.build_count || 0) + (succeeded ? 1 : 0),
    updated_at: new Date().toISOString(),
  });
}

async function isSubscriptionActive(userId) {
  const { data } = await supabaseAdmin.from("subscriptions").select("status").eq("user_id", userId).maybeSingle();
  return data?.status === "active";
}

// Lets the signed-in browser show "Pro" vs "Free" up front, instead of the user only
// finding out their subscription isn't active when a generation gets rejected. Mirrors
// the same x-vc-session check resolveMode() already does; this is read-only, no billing
// side effects.
app.get("/api/managed/status", async (req, res) => {
  const user = await getManagedUser(req);
  if (!user) return res.json({ signedIn: false });
  const active = await isSubscriptionActive(user.id);
  const usage = active ? await getManagedUsage(user.id) : null;
  res.json({
    signedIn: true,
    email: user.email,
    name: user.user_metadata?.full_name || user.user_metadata?.name || null,
    plan: active ? "pro" : "free",
    budget: MANAGED_MONTHLY_BUDGET,
    spent: usage?.spent ?? null,
    builds: usage?.builds ?? null,
  });
});

// Fire-and-forget welcome email, called by the client right after a genuine sign-in
// event (see the SIGNED_IN check around onAuthStateChange in public/app.js) — not on
// every page load with an already-open session. Idempotent server-side via a
// user_metadata flag, since the client alone can't reliably tell "first ever sign-in"
// from "logged back in on a new device"; SIGNED_IN fires for both.
app.post("/api/welcome-email", async (req, res) => {
  const user = await getManagedUser(req);
  if (!user) return res.status(401).json({ error: "no_session" });
  if (user.user_metadata?.welcomed) return res.json({ sent: false, reason: "already_welcomed" });
  if (!supabaseAdmin) return res.status(503).json({ error: "not_configured" });

  const name = user.user_metadata?.full_name || user.user_metadata?.name || null;
  const result = await sendEmail({
    to: user.email,
    subject: "Welcome to VibeSafe Builder",
    html: welcomeEmailHtml({ name }),
  });
  // Mark as welcomed regardless of send success — a flaky/unconfigured provider
  // shouldn't retry-spam on every subsequent login; hello@vibesafebuilder.com (shown
  // on the auth gate) is the fallback if someone never got it.
  await supabaseAdmin.auth.admin.updateUserById(user.id, {
    user_metadata: { ...user.user_metadata, welcomed: true },
  });
  res.json({ sent: result.ok });
});

/* ---------------- admin dashboard (owner-only: who's signed in, subscription status, usage) ---------------- */

// Single-secret gate, not a real auth system — deliberately simple since this has
// exactly one legitimate user (the owner). Set ADMIN_KEY in Vercel env vars to
// enable; the route 404s (not 401 — no need to reveal it exists) if unset.
const ADMIN_KEY = process.env.ADMIN_KEY;

function requireAdmin(req, res) {
  if (!ADMIN_KEY) {
    res.status(404).end();
    return false;
  }
  const key = req.header("x-admin-key") || req.query.key;
  if (key !== ADMIN_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

app.get("/api/admin/users", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!supabaseAdmin) {
    return res.status(503).json({ error: "Missing SUPABASE_SERVICE_ROLE_KEY — admin data isn't available on this server." });
  }
  try {
    const { data: userPage, error: userErr } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
    if (userErr) throw userErr;
    const users = userPage?.users || [];
    const ids = users.map((u) => u.id);

    // user_id is a uuid column — an empty IN-list still needs a real query (not a
    // placeholder string like "-", which Postgres rejects as an invalid uuid). Skipping
    // the query entirely when there are no users yet (a fresh project) sidesteps that.
    const [{ data: subs, error: subErr }, { data: usage, error: usageErr }] = ids.length
      ? await Promise.all([
          supabaseAdmin.from("subscriptions").select("user_id, status, stripe_customer_id, updated_at").in("user_id", ids),
          supabaseAdmin.from("managed_usage").select("user_id, dollars_spent, build_count").eq("period", currentPeriod()).in("user_id", ids),
        ])
      : [{ data: [], error: null }, { data: [], error: null }];
    if (subErr) throw subErr;
    if (usageErr) throw usageErr;

    const subByUser = Object.fromEntries((subs || []).map((s) => [s.user_id, s]));
    const usageByUser = Object.fromEntries((usage || []).map((u) => [u.user_id, u]));

    const rows = users
      .map((u) => {
        const sub = subByUser[u.id];
        const use = usageByUser[u.id];
        return {
          id: u.id,
          email: u.email,
          createdAt: u.created_at,
          lastSignInAt: u.last_sign_in_at || null,
          subscriptionStatus: sub?.status || "none",
          stripeCustomerId: sub?.stripe_customer_id || null,
          periodSpent: use?.dollars_spent || 0,
          periodBuilds: use?.build_count || 0,
        };
      })
      .sort((a, b) => new Date(b.lastSignInAt || b.createdAt) - new Date(a.lastSignInAt || a.createdAt));

    const summary = {
      period: currentPeriod(),
      totalUsers: rows.length,
      activeSubscriptions: rows.filter((r) => r.subscriptionStatus === "active").length,
      totalSpentThisPeriod: rows.reduce((s, r) => s + r.periodSpent, 0),
      totalBuildsThisPeriod: rows.reduce((s, r) => s + r.periodBuilds, 0),
      budgetPerUser: MANAGED_MONTHLY_BUDGET,
    };

    res.json({ summary, users: rows });
  } catch (err) {
    console.error("Admin users fetch error:", err);
    res.status(500).json({ error: "Could not load admin data: " + (err.message || "unknown error") });
  }
});

app.get("/admin", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin.html")));

/* ---------------- backend-for-generated-apps (see lib/appBackend.js) ---------------- */

registerAppBackendRoutes(app, { supabaseAdmin });

// Resolves how to serve this request: managed plan (session token, our key,
// budget-enforced) or bring-your-own-key (their key, unlimited). Managed mode
// is checked first — a signed-in managed customer never needs to think about
// keys at all.
async function resolveMode(req) {
  const managedUser = await getManagedUser(req);
  // A signed-in account with an active subscription gets the full managed path.
  // A signed-in account WITHOUT one (every account starts this way now that sign-in
  // is required for everyone, not just paying customers) falls through to BYOK below —
  // being signed in and being a paying Managed customer are separate facts; only the
  // second one used to be required to reach here at all, which wrongly hard-blocked
  // free/BYOK use for anyone who'd signed in without also having paid.
  if (managedUser && (await isSubscriptionActive(managedUser.id))) {
    const serverKey = process.env.ANTHROPIC_API_KEY;
    if (!serverKey) return { error: "The managed plan isn't configured on this server yet.", status: 503 };
    const usage = await getManagedUsage(managedUser.id);
    return { client: new Anthropic({ apiKey: serverKey }), mode: "managed", userId: managedUser.id, usage };
  }
  // Deliberately does NOT fall back to process.env.ANTHROPIC_API_KEY here: that key is
  // reserved for active Managed-plan users (budget-tracked above). Falling back to it
  // for anyone who omits x-anthropic-key would let any signed-in-but-free visitor
  // generate on the platform's own key for free, with no budget cap.
  const key = req.header("x-anthropic-key");
  if (!key) return { error: "no_key", status: 401 };
  return { client: new Anthropic({ apiKey: key }), mode: "byok" };
}

function buildMessages(prompt, currentCode, strategy) {
  let text = "";
  if (currentCode) {
    text += `CURRENT CODE of my app:\n\`\`\`html\n${currentCode}\n\`\`\`\n\n`;
  }
  if (strategy === "rethink") {
    text += `NOTE: Previous attempts to fix this did NOT work. Stop, re-diagnose the root cause step by step, and take a genuinely different approach — do not repeat earlier fixes.\n\n`;
  }
  text += currentCode ? `MY REQUEST: ${prompt}` : `Build me this app: ${prompt}`;
  return [{ role: "user", content: text }];
}

function costUSD(usage) {
  const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
  const outTok = usage.output_tokens || 0;
  return (inTok / 1e6) * INPUT_PER_MTOK + (outTok / 1e6) * OUTPUT_PER_MTOK;
}

// Cost estimate before generating — uses the free count_tokens endpoint.
// Managed users skip the cap check here (estimating costs nothing); the cap
// is only enforced on the actual generation below.
app.post("/api/estimate", async (req, res) => {
  const resolved = await resolveMode(req);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  const { client, mode, usage } = resolved;
  try {
    const { prompt = "", currentCode = "" } = req.body;
    const count = await client.messages.countTokens({
      model: MODEL,
      system: SYSTEM_PROMPT,
      messages: buildMessages(prompt, currentCode, null),
    });
    const inputTokens = count.input_tokens;
    // Output is roughly the size of the app being (re)generated, plus headroom for thinking.
    const codeTokens = Math.max(2500, Math.ceil(currentCode.length / 3.2));
    const estOutLow = Math.round(codeTokens * 0.9);
    const estOutHigh = Math.round(codeTokens * 2.2 + 2000);
    const low = (inputTokens / 1e6) * INPUT_PER_MTOK + (estOutLow / 1e6) * OUTPUT_PER_MTOK;
    const high = (inputTokens / 1e6) * INPUT_PER_MTOK + (estOutHigh / 1e6) * OUTPUT_PER_MTOK;
    const payload = { inputTokens, low, high, mode };
    if (mode === "managed") {
      payload.budget = MANAGED_MONTHLY_BUDGET;
      payload.spent = usage.spent;
      payload.buildsThisMonth = usage.builds;
    }
    res.json(payload);
  } catch (err) {
    res.status(err.status || 500).json({ error: describeError(err) });
  }
});

// Generation with SSE streaming.
app.post("/api/generate", async (req, res) => {
  const resolved = await resolveMode(req);
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
  const { client, mode, userId, usage } = resolved;

  // Managed-plan cap: pause, never silently overage-bill. Checked here (not
  // just on /api/estimate) because this is the request that actually spends.
  if (mode === "managed" && usage.spent >= MANAGED_MONTHLY_BUDGET) {
    return res.status(402).json({
      error: `You've used your included builds for this month ($${usage.spent.toFixed(2)} of $${MANAGED_MONTHLY_BUDGET.toFixed(2)}). It resets next billing cycle — or switch to your own API key in Settings to keep going now.`,
      capReached: true,
    });
  }

  const { prompt = "", currentCode = "", strategy = null } = req.body;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      thinking: { type: "adaptive" },
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      messages: buildMessages(prompt, currentCode, strategy),
    });

    stream.on("text", (t) => send({ type: "text", t }));

    const final = await stream.finalMessage();
    const fullText = final.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    const genCost = costUSD(final.usage);
    const succeeded = final.stop_reason !== "refusal" && /<html[\s>]/i.test(fullText);
    // Always record real cost against the budget (Anthropic bills us for the
    // tokens whether or not the output was usable) — but the visible build
    // count only advances on success, keeping "failures don't count against
    // you" true from the user's side while still protecting our own spend.
    if (mode === "managed") {
      await recordManagedUsage(userId, genCost, succeeded);
    }
    send({
      type: "done",
      text: fullText,
      usage: final.usage,
      cost: genCost,
      mode,
      stopReason: final.stop_reason,
      model: final.model,
    });
  } catch (err) {
    send({ type: "error", message: describeError(err) });
  } finally {
    res.end();
  }
});

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Invalid API key — check Settings.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the API — wait a minute and try again.";
  if (err instanceof Anthropic.APIConnectionError) return "Network error reaching the Claude API.";
  if (err instanceof Anthropic.APIError) return `API error (${err.status}): ${err.message}`;
  return err.message || "Unknown error";
}

module.exports = app;
