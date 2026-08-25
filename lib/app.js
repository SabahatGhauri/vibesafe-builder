const path = require("path");
const express = require("express");
const Anthropic = require("@anthropic-ai/sdk");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");
const { sendEmail, welcomeEmailHtml, proActivationEmailHtml } = require("./email");
const { reconcile } = require("./reconcile");
const { findUserIdByEmail: findUserId } = require("./findUser");
const { validateAnthropicKey } = require("./validateKey");
const { registerAppBackendRoutes, provisionAppKey, injectBackendConfig } = require("./appBackend");
const {
  parseMultiFileResponse,
  applyFileChanges,
  validateFiles,
  assembleProject,
  concatSources,
  withScaffold,
  hasScaffold,
  SCAFFOLD_FILES,
} = require("./multifile");
const { applyStyleEdit, applyTextEdit } = require("./visualEdit");
const { registerGithubRoutes } = require("./githubRoutes");
const { registerVercelRoutes } = require("./vercelRoutes");
const { paletteInstruction } = require("./palette");
const { prepareArtifact, scanBlockers, getProvider, listProviders } = require("./deploy");

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

// Baseline security headers on every response. Hand-written rather than a
// dependency (helmet etc.) — matches this codebase's existing pattern of
// plain fetch over SDKs, and it's a handful of headers, not worth a package.
//
// The CSP here is deliberately permissive on script-src/style-src
// ('unsafe-inline') rather than a stricter nonce-based policy — checked what
// the site actually uses before writing this, not guessed: landing.html has
// one inline <script> block and inline style="" attributes throughout every
// page, and index.html loads Supabase's SDK from jsdelivr. A strict CSP would
// break all of that immediately; this restricts what actually matters for a
// site like this — no framing (clickjacking), no <object>/<embed>, no loading
// resources from unexpected origins — without a much bigger rewrite to move
// every inline style and script out first.
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'",
    ].join("; ")
  );
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

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

  // Log every delivery. When this endpoint started failing there was no record
  // of what Stripe had sent, which made the outage far harder to diagnose than
  // it should have been.
  console.log("[stripe-webhook] received", event.type, event.id);

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const email = session.customer_details?.email || session.customer_email;
      if (email) await activateManagedAccess(email, session.customer);
      else console.error("[stripe-webhook] no email on session", session.id);
    } else if (event.type === "customer.subscription.deleted" || event.type === "customer.subscription.updated") {
      const sub = event.data.object;
      const status = sub.status === "active" || sub.status === "trialing" ? "active" : "canceled";
      await supabaseAdmin.from("subscriptions").update({ status, updated_at: new Date().toISOString() }).eq("stripe_customer_id", sub.customer);
    } else if (event.type === "customer.subscription.created" || event.type === "invoice.payment_succeeded") {
      // Not the primary activation path, but a cheap second chance: if the
      // checkout.session.completed delivery was the one that got lost, this
      // still gets the customer their access. activateManagedAccess is an
      // upsert keyed on the user, so running twice is harmless.
      const obj = event.data.object;
      const customerId = obj.customer;
      if (customerId) {
        const customer = await stripe.customers.retrieve(customerId).catch(() => null);
        const email = customer && !customer.deleted ? customer.email : null;
        if (email) await activateManagedAccess(email, customerId);
      }
    }
    res.json({ received: true });
  } catch (err) {
    // A 500 makes Stripe retry, which is what we want for a transient failure.
    // The reconcile endpoint is the backstop for when the retries run out.
    console.error("[stripe-webhook] handling error for", event.type, event.id, err);
    res.status(500).send("Webhook handler error");
  }
});

// Delegates to lib/findUser.js, which pages and matches the address explicitly.
// The previous version passed ?email= to Supabase's admin endpoint and took
// users[0] - but that endpoint supports only page/per_page, so the filter was
// silently ignored and users[0] was an arbitrary account. See lib/findUser.js.
async function findUserIdByEmail(email) {
  return findUserId(email, { supabaseUrl: SUPABASE_URL, serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY });
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
app.get("/app", (req, res) => {
  // The builder's own CSP, overriding the strict global default set above —
  // needed because the live preview for a multi-file project renders inside a
  // srcdoc iframe, and a srcdoc iframe inherits its parent document's CSP
  // unless the iframe content sets its own. Verified this directly rather than
  // assuming: the global CSP (no 'unsafe-eval') genuinely blocked the preview's
  // new Function()-based module loader in a real browser test before this
  // override was added. Otherwise identical in spirit to the published-app CSP
  // at /p/:id below — same CDN allowlist, since a project being edited here can
  // load the same libraries it could once published.
  //
  // connect-src includes *.supabase.co — this is the ACTUAL bug this comment
  // is here to prevent recurring. Sign-in (email/password and OAuth both call
  // Supabase's REST API via fetch from the browser — this.sb.auth.signUp /
  // signInWithPassword / signInWithOAuth / getSession all hit
  // https://<project-ref>.supabase.co directly, a different origin from
  // vibesafebuilder.com) was silently broken in production for a period after
  // the CSP was first added, because connect-src had no Supabase entry at all.
  // A wildcard subdomain, not the specific project ref, so a future project
  // rotation can't silently reintroduce the exact same outage.
  res.set(
    "Content-Security-Policy",
    "default-src 'self' data: blob:; " +
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://esm.sh; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com; " +
      "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net; " +
      "img-src 'self' data: blob: https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com; " +
      "connect-src 'self' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://esm.sh https://*.supabase.co; " +
      "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self';"
  );
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

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

/* ---------------- deployment ---------------- */

// What providers get handed. Everything a target might need to reach storage or
// wrap an artifact, passed in rather than imported, so lib/deploy.js has no
// dependency back on this file.
function deployCtx(extra) {
  const { injectPWATags } = require("./pwa");
  return {
    supabase,
    supabaseAdmin,
    siteUrl: SITE_URL,
    randomId,
    injectPWATags,
    provisionAppKey,
    injectBackendConfig,
    ...extra,
  };
}

/* ---------------- publishing (Supabase-backed — survives serverless restarts) ---------------- */

// The server-side security gate now lives in lib/deploy.js as DEPLOY_BLOCKERS,
// so it applies to EVERY deployment target rather than only our own hosting.

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
  // Thin now: all the target-specific work lives in lib/deploy.js so the same
  // path serves every provider. This route keeps its exact request/response
  // contract, so the browser needs no changes.
  if (!supabase || !supabaseAdmin) {
    return res.status(503).json({
      error: "Publishing isn't configured on this server (missing SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY).",
    });
  }
  const { code = "", id = null, publishKey = null, kind = "single", files = null } = req.body;

  // ---- stage: VALIDATING / BUILDING ----
  let artifact;
  try {
    artifact = prepareArtifact({ kind, code, files });
  } catch (err) {
    return res.status(400).json({ error: err.message, stage: err.stage || "validating" });
  }

  // Replay protection: a retried request (slow connection, refresh mid-publish,
  // double-click) carrying the same publishKey returns the original result rather
  // than running the whole publish again. A deliberate republish sends a fresh key.
  if (publishKey) {
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
  const blockers = scanBlockers(artifact.scanSource);
  if (blockers.length) {
    return res.status(422).json({ error: "Blocked by security scan", blockers, stage: "security_check" });
  }

  const publishId = id && /^[a-zA-Z0-9_-]{6,24}$/.test(id) ? id : randomId();

  async function recordAttempt(status, failureStage, failureReason) {
    if (!publishKey) return;
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

  // ---- stage: PUBLISHING / PROVISIONING ----
  try {
    const result = await getProvider("vibesafe").deploy(deployCtx(), {
      artifact,
      environment: "production",
      appId: publishId,
    });
    await recordAttempt(result.backendReady ? "published" : "published_without_backend");
    res.json({ id: result.id, url: result.url, backendReady: result.backendReady });
  } catch (err) {
    await recordAttempt("failed", "publishing", err.message);
    res.status(500).json({ error: err.message, stage: "publishing" });
  }
});

// Assembles a multi-file project into previewable HTML. The browser could in
// principle do this itself, but then the assembler would exist twice — here and
// in the client — and the two would drift. One implementation, one set of unit
// tests, used by both the preview and the publish path.
app.post("/api/assemble", (req, res) => {
  const { files = null } = req.body || {};
  const errs = validateFiles(files || {});
  if (errs.length) return res.status(400).json({ error: errs.join(" ") });
  try {
    res.json({ html: assembleProject(files) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Applies one visual-editor change to the project's source files and returns the
// updated files plus freshly assembled HTML. Kept server-side so the JSX surgery
// has exactly one implementation, unit-tested, shared with nothing else.
app.post("/api/visual-edit", (req, res) => {
  const { files = null, loc = null, styles = null, text = null } = req.body || {};
  if (!files || typeof files !== "object") return res.status(400).json({ error: "No project files supplied." });

  let result = { files };
  if (styles && Object.keys(styles).length) {
    result = applyStyleEdit(result.files, loc, styles);
    if (result.error) return res.status(400).json({ error: result.error });
  }
  if (typeof text === "string") {
    result = applyTextEdit(result.files, loc, text);
    if (result.error) return res.status(400).json({ error: result.error });
  }

  const errs = validateFiles(result.files);
  if (errs.length) return res.status(400).json({ error: errs.join(" ") });
  try {
    res.json({ files: result.files, html: assembleProject(result.files) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// A shareable snapshot of a work-in-progress build, deliberately separate from
// publishing. It shares the published_apps store (so /p/:id serves it with no
// extra plumbing) but gets its own id prefix, is never given backend credentials,
// and carries noindex — a preview is for showing someone your progress, not for
// shipping. The security scan still runs: a preview link is a public URL.
app.post("/api/preview-link", async (req, res) => {
  if (!supabase || !supabaseAdmin) return res.status(503).json({ error: "Previews aren't configured on this server." });
  const { files = null, id = null, kind = "multi", code = "" } = req.body || {};
  let artifact;
  try {
    artifact = prepareArtifact({ kind, code, files });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const blockers = scanBlockers(artifact.scanSource);
  if (blockers.length) return res.status(422).json({ error: "Blocked by security scan", blockers });

  const previewId = id && /^pv[a-zA-Z0-9_-]{4,22}$/.test(id) ? id : null;
  try {
    const result = await getProvider("vibesafe").deploy(deployCtx(), {
      artifact,
      environment: "preview",
      appId: previewId,
    });
    res.json({ id: result.id, url: result.url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  // Published apps share this origin with the builder (see DEPLOY_BLOCKERS in lib/deploy.js for
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
      // esm.sh added alongside the existing three: MULTIFILE_PROMPT's 3D-visuals
      // guidance tells the model to load Three.js from esm.sh specifically
      // (verified working via dynamic import against the real module loader) —
      // without it here, a published multi-file project using 3D would silently
      // fail to load its own dependency.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://esm.sh; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com; " +
      "font-src 'self' data: https://fonts.gstatic.com https://cdn.jsdelivr.net; " +
      "img-src 'self' data: blob: https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com; " +
      "connect-src 'self' https://cdn.jsdelivr.net https://unpkg.com https://cdnjs.cloudflare.com https://esm.sh; " +
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
- The <title> must name the actual app, never a generic placeholder like "My App".
- Basic accessibility, always: semantic HTML (<button>, <nav>, <label>, headings in order — not
  a <div> pretending to be everything), alt text on meaningful images, every interactive control
  reachable and operable by keyboard alone, and text/background contrast that stays readable.
- Include a small inline favicon (an emoji or a simple inline SVG as a data: URI is enough —
  no external asset needed) rather than leaving the tab icon blank.

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
password in a record — always use the auth endpoints above, which hash server-side.

3D VISUALS (optional — only when the request clearly calls for it, e.g. "a 3D product
showcase", "an interactive 3D hero", "a rotating 3D model", "a spinning logo"):
Most apps should NOT use 3D — it adds real complexity and failure risk for no benefit on
an ordinary form, dashboard, or utility app. Only reach for it when 3D is clearly the
point of the request, never as unrequested decoration.

When it IS needed: use Three.js from a CDN as an ES module (e.g.
https://cdn.jsdelivr.net/npm/three@<recent version>/build/three.module.js) — not raw
WebGPU. Three.js works in every browser (WebGPU is still not on by default in Firefox),
and is far more reliable to generate correctly in a single attempt. Keep the scene
SIMPLE and ROBUST over ambitious: one well-lit object with gentle auto-rotation is much
more likely to actually work than a multi-object cinematic scene with camera moves.

Always, without exception:
- Wrap all Three.js/WebGL setup in try/catch. If it throws, or the browser has no WebGL,
  render a plain, still-attractive CSS fallback (a gradient, a static illustration, or
  clean typography) instead — a broken 3D scene must never be the only thing on the page.
- Respect \`prefers-reduced-motion\` (\`window.matchMedia('(prefers-reduced-motion: reduce)').matches\`)
  — skip the animation loop entirely when it's set, rather than animating anyway.
- Pause the animation loop when the tab isn't visible (\`document.visibilityState\`).
- Never let the 3D canvas block the rest of the page — content and navigation must work
  even before the scene finishes loading, and if it never loads at all.

MARKETING / LANDING PAGE STRUCTURE (optional — only when the request is clearly for a
marketing site, landing page, or a product/SaaS-style page, e.g. "a landing page for my
app", "a website for my business", "a page to sell X"; NOT for a personal tool, internal
utility, or anything without an intended external visitor):
A page like this reads as professional when a first-time visitor can answer, within
seconds: what is this, who is it for, why should I care, what do I do next. Reach for
whichever of these actually fit the request — most single-page sites don't need all of
them:
- A clear hero: one strong headline, a short explanation, and a primary call-to-action.
- A features or "how it works" section — concrete, not vague marketing filler.
- Pricing, only if the request implies a paid product and gives you something to show.
- An FAQ, if there's enough real content to justify one.
- A footer with real links (even if some just point to "#" placeholders) rather than none.

NEVER FABRICATE, under any circumstance: testimonials, reviews, star ratings, "trusted by"
customer logos, or specific customer/user counts ("10,000+ users", "500 companies"). These
read as real claims about a real business, and inventing them for someone's actual
business is generating deceptive content, not a design flourish. If the request doesn't
supply real numbers or quotes, either leave that section out entirely, or build it with
clearly-marked placeholder content ("Add your first testimonial here") the user is
obviously meant to replace — never a number or quote dressed up to look real.`;

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

/* Repairs the gap a missed webhook leaves behind. Stripe is the source of
   truth for who has paid; this compares its entitled subscriptions against the
   subscriptions table and reports what disagrees.

   GET  /api/admin/reconcile          - dry run, reports only
   POST /api/admin/reconcile?apply=1  - provisions the customers found missing

   Deliberately two different verbs: a dry run has to be the thing that is easy
   to reach by accident, not the write. */
app.all("/api/admin/reconcile", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!supabaseAdmin || !STRIPE_SECRET_KEY) {
    return res.status(503).json({ error: "Needs SUPABASE_SERVICE_ROLE_KEY and STRIPE_SECRET_KEY to be set." });
  }
  // Writing requires POST *and* the flag, so a browser hitting the URL can only
  // ever read.
  const apply = req.method === "POST" && (req.query.apply === "1" || req.query.apply === "true");
  try {
    const report = await reconcile({ stripe, supabaseAdmin, activate: activateManagedAccess, apply });
    res.json(report);
  } catch (err) {
    console.error("Reconcile failed:", err);
    res.status(500).json({ error: err.message });
  }
});

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

/* Tells a BYOK user whether the key they just pasted actually works, instead of
   letting them find out from a failed build. Costs nothing: it hits Anthropic's
   models endpoint, which is metadata, not generation.

   The key travels in a header and is never logged - the same path a generation
   request already uses, so this exposes nothing new. */
app.post("/api/validate-key", async (req, res) => {
  const key = req.header("x-anthropic-key") || "";
  const result = await validateAnthropicKey(key);
  res.json(result);
});

app.get("/admin", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "admin.html")));

/* ---------------- backend-for-generated-apps (see lib/appBackend.js) ---------------- */

registerAppBackendRoutes(app, { supabaseAdmin });

/* ---------------- GitHub sync (see lib/github.js) ---------------- */

registerGithubRoutes(app, { supabaseAdmin, getManagedUser, siteUrl: SITE_URL });
registerVercelRoutes(app, { supabaseAdmin, getManagedUser });

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
  if (!key) {
    // This used to return the bare sentinel "no_key", which the client rendered
    // verbatim — a signed-in free user asking for an app was simply told
    // "no_key". It's the most likely first-run state there is, so it gets a real
    // explanation of both ways forward.
    return {
      error:
        "You're on the Free plan, which needs your own Anthropic API key. Add one in Settings (it stays in your browser and is sent straight to Anthropic), or upgrade to the Managed plan and we'll cover the key and the budget for you.",
      status: 401,
      reason: "no_key",
    };
  }
  return { client: new Anthropic({ apiKey: key }), mode: "byok" };
}

function buildMessages(prompt, currentCode, strategy, palette) {
  let text = "";
  if (currentCode) {
    text += `CURRENT CODE of my app:\n\`\`\`html\n${currentCode}\n\`\`\`\n\n`;
  }
  if (strategy === "rethink") {
    text += `NOTE: Previous attempts to fix this did NOT work. Stop, re-diagnose the root cause step by step, and take a genuinely different approach — do not repeat earlier fixes.\n\n`;
  }
  // Placed right before the request itself, since it's a constraint on HOW to
  // fulfil it. Applies on every generation the palette is attached to, not
  // just the first — so an app doesn't drift off-palette as it's edited.
  text += paletteInstruction(palette);
  text += currentCode ? `MY REQUEST: ${prompt}` : `Build me this app: ${prompt}`;
  return [{ role: "user", content: text }];
}

/* ---------------- multi-file projects (Phase 2A) ---------------- */

// A separate prompt rather than a branch inside SYSTEM_PROMPT: the two modes
// have different output formats, different editing rules and different
// constraints, and interleaving them made both harder for the model to follow.
// Single-file generation is completely untouched by this.
const MULTIFILE_PROMPT = `You are the code generator inside VibeSafe Builder, building REACT projects made of multiple files.

OUTPUT FORMAT — reply with exactly:
1. One short friendly sentence (max 25 words) saying what you did.
2. Then, for EVERY file you are creating or changing, a block in exactly this form:

FILE: src/components/Thing.jsx
\`\`\`jsx
...the complete new contents of that file...
\`\`\`

Rules for the file blocks:
- The FILE: line comes first, then the fenced block. Nothing else between them.
- Always give the COMPLETE contents of each file you touch — never a fragment, never a diff.
- ONLY include files you actually changed. Unlisted files are left exactly as they are.
  If a request needs 4 files changed out of 12, output 4 blocks, not 12.
- To delete a file, output its FILE: block with the single word DELETE_FILE as the body.
- Never write prose after the last block.

PROJECT SHAPE:
- This is a real Vite + React project. package.json, vite.config.js, index.html and
  README.md are created and maintained automatically — do NOT write them yourself
  unless the user specifically asks to change one. Just write the src/ files.
- Entry point must be src/main.jsx. It renders into <div id="root">, which already exists.
- Use src/App.jsx for the root component, src/components/ for components,
  src/hooks/ for hooks, src/utils/ for helpers, src/styles.css for styling.
- Paths are relative to the project root. No leading slash, no "..\" escaping the project.

IMPORTS — this is important, the project is built in the browser with no bundler:
- You may import ONLY: "react", "react-dom", "react-dom/client", and relative paths
  to other project files. No other npm packages exist — no react-router, no axios,
  no lodash, no UI kits. Write what you need yourself.
- Always include the file extension on relative imports: "./components/Header.jsx",
  not "./components/Header".
- import "./styles.css" is allowed and is a no-op at runtime (CSS is applied globally).
- JSX is supported. TypeScript is NOT — use .js and .jsx only.

EDITING RULES:
- Make the smallest change that fulfils the request. Preserve everything that works.
- Keep components small and focused; put new components in their own files.
- If the user reports a bug you already tried to fix, re-diagnose from scratch and
  take a different approach — do not repeat the failed fix.

SECURITY RULES (non-negotiable):
- NEVER hardcode API keys, tokens, passwords, or secrets. If a feature needs a key,
  ask the user for it at runtime and keep it in memory only.
- No third-party analytics or tracking.
- Don't use eval() or new Function().
- Never send user data anywhere the user didn't explicitly ask for.

QUALITY RULES:
- The app must be complete and immediately usable — working buttons, sensible empty
  states, no TODOs or placeholders.
- Distinctive modern design: real colour palette, good typography and spacing.
- Mobile-friendly by default. Persist data with localStorage where it makes sense.
  (index.html's <title> is set automatically from the project name — you don't need to
  touch it, and shouldn't, per PROJECT SHAPE above.)
- Basic accessibility, always: semantic HTML, alt text on meaningful images, every
  interactive control reachable and operable by keyboard alone, and text/background
  contrast that stays readable.
- Include a small inline favicon (an emoji or a simple inline SVG as a data: URI is
  enough) rather than leaving the tab icon blank.

3D VISUALS (optional — only when the request clearly calls for it, e.g. "a 3D product
showcase", "an interactive 3D hero", "a rotating 3D model", "a spinning logo"):
Most apps should NOT use 3D — it adds real complexity and failure risk for no benefit on
an ordinary form, dashboard, or utility app. Only reach for it when 3D is clearly the
point of the request, never as unrequested decoration.

When it IS needed: THIS PROJECT'S MODULE SYSTEM ONLY RESOLVES REACT AND RELATIVE IMPORTS —
a normal \`import * as THREE from "https://..."\` will fail with "only React and relative
paths are supported." Load Three.js with a DYNAMIC import instead, inside a useEffect:
\`const THREE = await import("https://esm.sh/three@<recent version>");\` — this works
because it calls the browser's real dynamic import directly, bypassing this project's
module resolver rather than going through it. Not raw WebGPU: Three.js works in every
browser (WebGPU is still not on by default in Firefox) and is far more reliable to
generate correctly in a single attempt. Put it in its own component (e.g.
src/components/Scene3D.jsx) so the rest of the app is unaffected if it fails. Keep the
scene SIMPLE and ROBUST over ambitious: one well-lit object with gentle auto-rotation is
much more likely to actually work than a multi-object cinematic scene with camera moves.

Always, without exception:
- The dynamic import is async, so state doesn't exist yet on first render — start in a
  "loading" state and only build the scene once the import resolves.
- Wrap the import AND all Three.js/WebGL setup in try/catch inside the useEffect, and track
  failure in state so the component can render a plain, still-attractive CSS fallback
  instead — a broken 3D scene must never be the only thing on the page.
- Respect \`prefers-reduced-motion\` (\`window.matchMedia('(prefers-reduced-motion: reduce)').matches\`)
  — skip the animation loop entirely when it's set, rather than animating anyway.
- Pause the animation loop when the tab isn't visible (\`document.visibilityState\`), and
  clean up the renderer/animation frame in the effect's cleanup function.
- Never let the 3D canvas block the rest of the app — content and navigation must work
  even before the scene finishes loading, and if it never loads at all.

MARKETING / LANDING PAGE STRUCTURE (optional — only when the request is clearly for a
marketing site, landing page, or a product/SaaS-style page; NOT for a personal tool,
internal utility, or anything without an intended external visitor):
A page like this reads as professional when a first-time visitor can answer, within
seconds: what is this, who is it for, why should I care, what do I do next. Reach for
whichever of these actually fit the request — most sites don't need all of them:
- A clear hero: one strong headline, a short explanation, and a primary call-to-action.
- A features or "how it works" section — concrete, not vague marketing filler.
- Pricing, only if the request implies a paid product and gives you something to show.
- An FAQ, if there's enough real content to justify one.
- A footer with real links (even if some just point to "#" placeholders) rather than none.

NEVER FABRICATE, under any circumstance: testimonials, reviews, star ratings, "trusted by"
customer logos, or specific customer/user counts ("10,000+ users", "500 companies"). These
read as real claims about a real business, and inventing them for someone's actual
business is generating deceptive content, not a design flourish. If the request doesn't
supply real numbers or quotes, either leave that section out entirely, or build it with
clearly-marked placeholder content ("Add your first testimonial here") the user is
obviously meant to replace — never a number or quote dressed up to look real.`;

// The model is shown the current file tree plus the full contents of every file,
// so it can reason about cross-file impact before choosing what to change. Files
// it doesn't return are preserved by applyFileChanges().
function buildMultiFileMessages(prompt, files, strategy, palette) {
  let text = "";
  const paths = Object.keys(files || {}).sort();
  if (paths.length) {
    text += `CURRENT PROJECT FILES (${paths.length}):\n${paths.map((p) => "  " + p).join("\n")}\n\n`;
    for (const p of paths) {
      const lang = p.endsWith(".css") ? "css" : p.endsWith(".jsx") ? "jsx" : p.endsWith(".html") ? "html" : "js";
      text += `FILE: ${p}\n\`\`\`${lang}\n${files[p]}\`\`\`\n\n`;
    }
  }
  if (strategy === "rethink") {
    text += `NOTE: Previous attempts to fix this did NOT work. Stop, re-diagnose the root cause step by step, and take a genuinely different approach — do not repeat earlier fixes.\n\n`;
  }
  text += paletteInstruction(palette);
  text += paths.length
    ? `MY REQUEST: ${prompt}\n\nRemember: output ONLY the files you actually change.`
    : `Build me this app as a React project: ${prompt}`;
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
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error, reason: resolved.reason || null });
  const { client, mode, usage } = resolved;
  try {
    const { prompt = "", currentCode = "", kind = "single", files = null, palette = null } = req.body;
    const isMulti = kind === "multi";
    const count = await client.messages.countTokens({
      model: MODEL,
      system: isMulti ? MULTIFILE_PROMPT : SYSTEM_PROMPT,
      messages: isMulti
        ? buildMultiFileMessages(prompt, files || {}, null, palette)
        : buildMessages(prompt, currentCode, null, palette),
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
  if (resolved.error) return res.status(resolved.status).json({ error: resolved.error, reason: resolved.reason || null });
  const { client, mode, userId, usage } = resolved;

  // Managed-plan cap: pause, never silently overage-bill. Checked here (not
  // just on /api/estimate) because this is the request that actually spends.
  if (mode === "managed" && usage.spent >= MANAGED_MONTHLY_BUDGET) {
    return res.status(402).json({
      error: `You've used your included builds for this month ($${usage.spent.toFixed(2)} of $${MANAGED_MONTHLY_BUDGET.toFixed(2)}). It resets next billing cycle — or switch to your own API key in Settings to keep going now.`,
      capReached: true,
    });
  }

  const { prompt = "", currentCode = "", strategy = null, kind = "single", files = null, palette = null } = req.body;
  const isMulti = kind === "multi";

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

  try {
    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      thinking: { type: "adaptive" },
      system: [
        {
          type: "text",
          text: isMulti ? MULTIFILE_PROMPT : SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      messages: isMulti
        ? buildMultiFileMessages(prompt, files || {}, strategy, palette)
        : buildMessages(prompt, currentCode, strategy, palette),
    });

    stream.on("text", (t) => send({ type: "text", t }));

    const final = await stream.finalMessage();
    const fullText = final.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    const genCost = costUSD(final.usage);

    // Multi-file responses are parsed server-side so the FILE-block format lives
    // in exactly one place (lib/multifile.js, unit-tested) rather than being
    // reimplemented in the browser. The client just merges what comes back.
    let changedFiles = null;
    if (isMulti) {
      changedFiles = parseMultiFileResponse(fullText).files;
      // Add the build scaffold on the first generation, so the project is a real
      // Vite app that runs outside this builder. Returned as part of the change
      // set rather than injected client-side, so there is one implementation and
      // the files show up in the tree, the diff, and any push to GitHub.
      if (Object.keys(changedFiles).length && !hasScaffold({ ...(files || {}), ...changedFiles })) {
        changedFiles = { ...withScaffold(changedFiles, { name: prompt.slice(0, 40) }), ...changedFiles };
      }
    }
    const succeeded =
      final.stop_reason !== "refusal" &&
      (isMulti ? Object.keys(changedFiles || {}).length > 0 : /<html[\s>]/i.test(fullText));

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
      files: changedFiles,
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

// Catch-all 404 — must be the LAST thing registered, so every real route above
// gets first chance to match. Replaces Express's bare default ("Cannot GET
// /path") with something on-brand and with a way back into the product.
app.use((req, res) => {
  res.status(404).sendFile(path.join(PUBLIC_DIR, "404.html"));
});

module.exports = app;
