// Phase 3A — Vercel as a deployment provider.
//
// Implements the same contract as the VibeSafe hosting provider in lib/deploy.js,
// so the deployment engine does not know or care which target it is talking to.
// That separation is the point: the credential mechanism here is a user-supplied
// access token today, and can become OAuth later without the engine changing.
//
// WHY A TOKEN AND NOT OAUTH (as of 2026-08)
// Vercel's own docs state that "permissions for issuing API requests and
// interacting with team resources are currently in private beta". The four
// available Sign-in-with-Vercel scopes (openid, email, profile, offline_access)
// are identity-only — an OAuth app built today could identify a user but could
// not deploy for them. So: token now, OAuth when that opens.
//
// CREDENTIAL HANDLING
//   * AES-256-GCM encrypted at rest, key domain-separated from every other
//     integration (lib/secrets.js)
//   * never sent to the browser, not even to display — the UI gets a masked hint
//   * never logged, never placed in a URL
//   * a project-scoped token is strongly preferred and detected, because it
//     cannot reach any other project, the team, or the account

const { makeCipher } = require("./secrets");

const API = "https://api.vercel.com";
const cipher = makeCipher("vibesafe-vercel-tokens", "VERCEL_TOKEN_SECRET");

/* ---------------- API plumbing ---------------- */

async function vc(token, path, { method = "GET", body = null } = {}) {
  const r = await fetch(API + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => null);
  if (!r.ok) {
    const err = new Error((data && data.error && data.error.message) || "Vercel API error " + r.status);
    err.status = r.status;
    err.code = data && data.error && data.error.code;
    throw err;
  }
  return data;
}

/* ---------------- token validation and scope detection ---------------- */

// One call answers three questions: is the token valid, how broadly does it
// reach, and which project should we deploy to. This is also the "Test
// connection" the UI exposes.
//
// Note on status codes: Vercel answers 404 (not 403) for resources outside a
// token's scope — sensibly, since 403 would confirm they exist. An earlier
// version of this check treated only 403 as "denied" and therefore reported a
// perfectly good project-scoped token as too broad.
async function inspectToken(token) {
  let projects;
  try {
    projects = await vc(token, "/v9/projects");
  } catch (err) {
    if (err.status === 401 || err.status === 403) {
      return { ok: false, error: "That token was rejected by Vercel. It may be revoked or expired." };
    }
    return { ok: false, error: err.message };
  }

  const list = (projects.projects || []).map((p) => ({
    id: p.id,
    name: p.name,
    framework: p.framework || null,
  }));

  // A project-scoped token sees exactly one project and cannot reach the
  // account. Anything wider is usable but worth warning about.
  let accountReachable = false;
  try {
    await vc(token, "/v2/user");
    accountReachable = true;
  } catch {
    accountReachable = false;
  }

  const scope = list.length === 1 && !accountReachable ? "project" : accountReachable ? "account" : "team";

  return {
    ok: true,
    scope,
    projects: list,
    // Surfaced so the UI can nudge without blocking — a broad token still works.
    warning:
      scope === "project"
        ? null
        : scope === "team"
        ? "This token can reach every project in the team. A project-scoped token would be safer."
        : "This token can reach your whole Vercel account, including other projects and their environment variables. A project-scoped token would be much safer.",
  };
}

/* ---------------- deployment protection ---------------- */

// Phase 3A DETECTS protection; it deliberately does not change it. Disabling a
// customer's security setting is a separate, explicitly confirmed action.
async function getProtection(token, projectId) {
  try {
    const p = await vc(token, "/v9/projects/" + encodeURIComponent(projectId));
    const sso = p.ssoProtection || null;
    const pw = p.passwordProtection || null;
    return {
      protected: Boolean(sso || pw),
      sso: sso ? sso.deploymentType || true : null,
      password: Boolean(pw),
      // What it means in plain terms, for the UI to show verbatim.
      explanation: sso
        ? "Deployment Protection is on for this Vercel project, so visitors are asked to log in to Vercel before they can see the site."
        : pw
        ? "This Vercel project is password protected, so visitors must enter a password before they can see the site."
        : null,
    };
  } catch {
    // Not knowing must never block a deployment that already succeeded.
    return { protected: null, sso: null, password: false, explanation: null };
  }
}

// Phase 3B — changing protection. Separated from getProtection() above so the
// read path and the write path are never confusable at a glance.
//
// `ssoProtection: null` is how Vercel disables it (confirmed against their REST
// reference, not inferred). Only the single project passed in is touched; there
// is no account-wide or team-wide call anywhere in this file.
async function setProtection(token, projectId, { enabled, deploymentType }) {
  const body = enabled ? { ssoProtection: { deploymentType: deploymentType || "all_except_custom_domains" } } : { ssoProtection: null };
  await vc(token, "/v9/projects/" + encodeURIComponent(projectId), { method: "PATCH", body });
  // Read it back rather than trusting the write. A 200 means Vercel accepted the
  // request; it does not by itself prove the setting is now what we asked for.
  return getProtection(token, projectId);
}

// Does an ordinary visitor with no Vercel account actually see the site?
//
// This is checked by looking, not by assuming the API call worked. A protected
// deployment answers 302 to vercel.com/sso-api — it does NOT answer 401, and
// following the redirect yields a 200 for VERCEL'S LOGIN PAGE, which is exactly
// how a naive check convinces itself everything is fine.
async function checkPublicAccess(url) {
  if (!url) return { public: null, reason: "No deployment URL to check yet." };
  let r;
  try {
    r = await fetch(url, { redirect: "manual" });
  } catch (err) {
    return { public: false, reason: "Could not reach the site: " + err.message };
  }

  const location = r.headers.get("location") || "";
  if (r.status >= 300 && r.status < 400 && /vercel\.com\/sso-api/.test(location)) {
    return {
      public: false,
      status: r.status,
      reason: "Visitors are still being redirected to a Vercel login page.",
    };
  }
  if (r.status === 401 || r.status === 403) {
    return { public: false, status: r.status, reason: "The site is still refusing anonymous visitors." };
  }
  if (r.status >= 200 && r.status < 400) {
    return { public: true, status: r.status, reason: "Anyone with the link can open the site." };
  }
  // A 500 is the app's own problem, not a protection problem — say so rather
  // than reporting a protection failure that isn't one.
  return {
    public: false,
    status: r.status,
    reason: "Protection is off, but the site returned " + r.status + ". That's the app failing, not access.",
  };
}

/* ---------------- deploying ---------------- */

// Vercel accepts files inline, base64 encoded. We send the PROJECT SOURCE —
// package.json, vite.config.js, src/… — not the assembled preview bundle, so
// Vercel runs a real `npm install && vite build`. That is the whole reason the
// scaffold exists: without package.json there would be nothing to build, and
// "deploy" would mean uploading one pre-built HTML file.
function filesToVercel(files) {
  return Object.entries(files).map(([file, data]) => ({
    file,
    data: Buffer.from(data, "utf8").toString("base64"),
    encoding: "base64",
  }));
}

async function createDeployment(token, { files, projectName, environment = "preview" }) {
  const body = {
    name: projectName,
    files: filesToVercel(files),
    projectSettings: { framework: "vite" },
  };
  // Omitting `target` produces a preview deployment; "production" promotes it.
  if (environment === "production") body.target = "production";

  const d = await vc(token, "/v13/deployments", { method: "POST", body });
  return {
    id: d.id,
    url: d.url ? "https://" + d.url : null,
    state: d.readyState || d.status || "QUEUED",
    projectId: d.projectId || null,
  };
}

async function getDeployment(token, deploymentId) {
  const d = await vc(token, "/v13/deployments/" + encodeURIComponent(deploymentId));
  return {
    id: d.id,
    url: d.url ? "https://" + d.url : null,
    state: d.readyState || d.status,
    // Vercel reports build failures here rather than as an HTTP error.
    error: d.errorMessage || d.errorCode || null,
    createdAt: d.createdAt || null,
  };
}

async function listDeployments(token, { projectId, limit = 10 }) {
  const d = await vc(token, `/v6/deployments?projectId=${encodeURIComponent(projectId)}&limit=${limit}`);
  return (d.deployments || []).map((x) => ({
    id: x.uid || x.id,
    url: x.url ? "https://" + x.url : null,
    state: x.readyState || x.state,
    target: x.target || "preview",
    createdAt: x.created || x.createdAt,
  }));
}

/* ---------------- provider ---------------- */

const vercel = {
  id: "vercel",
  name: "Vercel",
  needsConnection: true,

  isAvailable() {
    // Nothing to configure server-side — availability depends on whether the
    // individual user has connected a token, which status() reports.
    return true;
  },

  async status(ctx) {
    const conn = ctx.connection;
    if (!conn) return { connected: false };
    return {
      connected: true,
      account: conn.project_name || "Vercel",
      scope: conn.token_scope,
      projectName: conn.project_name,
      projectId: conn.project_id,
      tokenHint: conn.token_hint,
    };
  },

  // Same signature as the VibeSafe provider. It takes the project FILES rather
  // than the assembled artifact, because Vercel builds from source.
  async deploy(ctx, { files, environment = "preview", projectName }) {
    const token = ctx.vercelToken;
    if (!token) throw new Error("Connect a Vercel token first.");
    if (!files || !Object.keys(files).length) throw new Error("Nothing to deploy.");

    const created = await createDeployment(token, {
      files,
      projectName: projectName || ctx.projectName,
      environment,
    });
    return { ...created, environment, provider: "vercel" };
  },
};

module.exports = {
  vercel,
  inspectToken,
  getProtection,
  setProtection,
  checkPublicAccess,
  createDeployment,
  getDeployment,
  listDeployments,
  filesToVercel,
  encrypt: (v) => cipher.encrypt(v),
  decrypt: (v) => cipher.decrypt(v),
  hint: (v) => cipher.hint(v),
};
