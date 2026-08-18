// Phase 3A (step 2) — the deployment layer.
//
// VibeSafe already had a deployment target before this file existed: publishing
// to /p/:id, plus shareable preview links. They just weren't named that way. So
// this isn't "add deployment" — it's giving the thing that already works a
// shape that a second target (Vercel, and later others) can slot into.
//
// Two implementations from the start is the point. An interface designed against
// one implementation gets its seams wrong, because they end up drawn around
// imagined providers rather than real ones.
//
// PROVIDER CONTRACT
//   id, name, needsConnection
//   isAvailable(ctx)                     -> boolean
//   status(ctx)                          -> { connected, account }
//   deploy(ctx, { artifact, environment, appId, projectKey })
//                                        -> { id, url, environment }
//
// ctx carries { userId, supabaseAdmin, siteUrl } — whatever a provider needs to
// reach storage or the caller's stored credentials.
//
// ENVIRONMENTS
//   "preview"    a shareable snapshot of work in progress
//   "production" the real thing, at a stable URL
// Both already existed here as preview links and published apps respectively.

const { assembleProject, validateFiles, concatSources } = require("./multifile");

/* ---------------- security gate (applies to EVERY provider) ---------------- */

// Deliberately lives in the deployment layer rather than in the publish route.
// Anything that ships — to our hosting or to somebody's Vercel account — passes
// the same gate. A security product that only checks its own hosting would be
// checking the least important case.
const DEPLOY_BLOCKERS = [
  {
    label: "hardcoded API key or secret",
    re: /(sk-[a-zA-Z0-9_-]{18,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{20,}|ghp_[a-zA-Z0-9]{30,}|(api[_-]?key|secret|token|password)\s*[:=]\s*["'][A-Za-z0-9_\-\/+]{16,}["'])/i,
  },
  { label: "eval() / dynamic code execution", re: /\beval\s*\(|new\s+Function\s*\(/ },
  // Matches the client-side "No passwords stored in localStorage" check in
  // public/app.js — enforcing it only there could be bypassed by calling the
  // API directly.
  {
    label: "password stored in localStorage",
    re: /localStorage\.(setItem\s*\(\s*["'][^"']*(password|passwd|secret)|[a-zA-Z_]*(password|passwd|secret))/i,
  },
  // Apps hosted by us run on our origin, so their JS shares localStorage with
  // the builder — an app referencing our internal storage keys is trying to read
  // another visitor's BYOK key or session token. Targeted and low-false-positive;
  // the CSP on /p/:id is the second layer.
  {
    label: "reads the builder's own internal storage keys (possible credential theft)",
    re: /vc_apiKey|vc_project\b|vc_cap\b|sb-[\w-]+-auth-token|supabase\.auth\.(token|session)/i,
  },
];

// Kept as the one-line answer for the VibeSafe publish path, but now expressed
// in terms of the Launch Check gate rather than its own rule list. Two scanners
// would drift, and only one of them would get fixed.
//
// DEPLOY_BLOCKERS above is retained only as documentation of what this used to
// check; the live rules are in lib/securityGate.js.
function scanBlockers(source) {
  const { scanProject } = require("./securityGate");
  const scan = scanProject({ "project.js": source || "" });
  return scan.findings.filter((f) => f.severity === "critical" || f.severity === "high").map((f) => f.label);
}

/* ---------------- artifact preparation ---------------- */

// Turns a project — either kind — into the two things a deployment needs: the
// HTML to serve, and the source to scan. They differ for multi-file projects:
// the artifact contains our own module loader (which uses new Function), so
// scanning it would flag every single deployment. The scan must read what the
// MODEL wrote.
function prepareArtifact({ kind, code, files }) {
  if (kind === "multi") {
    const errors = validateFiles(files || {});
    if (errors.length) {
      const err = new Error(errors.join(" "));
      err.stage = "validating";
      throw err;
    }
    let html;
    try {
      html = assembleProject(files);
    } catch (e) {
      const err = new Error("Could not assemble the project: " + e.message);
      err.stage = "building";
      throw err;
    }
    return { html, scanSource: concatSources(files), kind: "multi", files };
  }

  if (!/<html[\s>]/i.test(code || "") || (code || "").length > 2_000_000) {
    const err = new Error("Not a valid app file.");
    err.stage = "validating";
    throw err;
  }
  return { html: code, scanSource: code, kind: "single" };
}

/* ---------------- provider: VibeSafe hosting ---------------- */

// The hosting that already existed. Preview and production differ in three ways
// that were previously spread across two separate routes:
//   preview     throwaway id, noindex, NO backend credentials
//   production  stable id, PWA tags, backend credentials provisioned
const vibesafe = {
  id: "vibesafe",
  name: "VibeSafe Hosting",
  needsConnection: false,

  isAvailable(ctx) {
    return Boolean(ctx.supabase && ctx.supabaseAdmin);
  },

  async status() {
    // Nothing to connect — it's the built-in target.
    return { connected: true, account: "VibeSafe Hosting" };
  },

  async deploy(ctx, { artifact, environment = "production", appId }) {
    const { supabase, supabaseAdmin } = ctx;
    const isPreview = environment === "preview";
    const id = appId || (isPreview ? "pv" + ctx.randomId() : ctx.randomId());

    let html = artifact.html;

    if (isPreview) {
      // A preview is a snapshot to show someone, not a deployment: no search
      // indexing, and deliberately no backend credentials, so a work-in-progress
      // link can never read or write the real app's data.
      html = html.replace(/<head[^>]*>/i, (m) => m + '<meta name="robots" content="noindex, nofollow" />');
      const { error } = await supabaseAdmin
        .from("published_apps")
        .upsert({ id, html, updated_at: new Date().toISOString() });
      if (error) throw new Error("Could not save the preview: " + error.message);
      return { id, url: "/p/" + id, environment, backendReady: false };
    }

    html = ctx.injectPWATags(html, { swUrl: `/p/${id}/sw.js` });

    // Writes go through the SERVICE-ROLE client. Publishing used to write with
    // the anon key, which forced permissive RLS policies on published_apps and
    // let anyone overwrite anyone's app — see docs/security-notes.md.
    const { error } = await supabaseAdmin
      .from("published_apps")
      .upsert({ id, html, updated_at: new Date().toISOString() });
    if (error) throw new Error("Could not save the published app: " + error.message);

    // Backend credentials come AFTER the row exists: app_backend_keys.app_id is
    // a foreign key to published_apps(id), so provisioning first would be
    // rejected on a brand-new app's very first publish.
    let backendReady = false;
    if (ctx.provisionAppKey && ctx.injectBackendConfig) {
      try {
        const appKey = await ctx.provisionAppKey(supabaseAdmin, id);
        html = ctx.injectBackendConfig(html, { appId: id, appKey });
        const { error: cfgError } = await supabaseAdmin
          .from("published_apps")
          .upsert({ id, html, updated_at: new Date().toISOString() });
        if (cfgError) throw cfgError;
        backendReady = true;
      } catch (err) {
        // Non-fatal: the app is already saved and serving. Failing the whole
        // deployment over an optional capability the generated code guards for
        // would throw away a working release.
        console.error("Could not provision backend for", id, err.message);
      }
    }

    return { id, url: "/p/" + id, environment, backendReady };
  },
};

/* ---------------- registry ---------------- */

const PROVIDERS = { [vibesafe.id]: vibesafe };

// Vercel registers itself at load. Safe to require here: deployVercel depends
// only on lib/secrets.js, so there is no cycle back into this file.
PROVIDERS.vercel = require("./deployVercel").vercel;

// Providers register themselves here as they're added (Vercel next). Kept as a
// plain object rather than a plugin system — there is no point building
// discovery machinery for a set this small and this well known.
function registerProvider(provider) {
  PROVIDERS[provider.id] = provider;
}

function getProvider(id) {
  return PROVIDERS[id] || null;
}

function listProviders(ctx) {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    name: p.name,
    needsConnection: p.needsConnection,
    available: p.isAvailable(ctx),
  }));
}

module.exports = {
  DEPLOY_BLOCKERS,
  scanBlockers,
  prepareArtifact,
  vibesafe,
  registerProvider,
  getProvider,
  listProviders,
};
